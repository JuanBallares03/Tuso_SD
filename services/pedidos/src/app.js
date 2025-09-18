// services/pedidos/src/app.js
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Logger básico
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'pedidos.log' })
  ]
});

// Conexión a PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432
});

// Conexión a RabbitMQ
let channel;
async function connectRabbitMQ() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue('saga_events', { durable: true });
  logger.info('RabbitMQ conectado');
}

// Middleware JWT básico
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
};

// Estados de la Saga
const SagaState = {
  INICIADA: 'INICIADA',
  INVENTARIO_RESERVADO: 'INVENTARIO_RESERVADO',
  PAGO_PROCESADO: 'PAGO_PROCESADO',
  COMPLETADA: 'COMPLETADA',
  CANCELADA: 'CANCELADA',
  COMPENSANDO: 'COMPENSANDO'
};

// Crear pedido (inicia Saga)
app.post('/pedidos', authenticateToken, async (req, res) => {
  const { productoId, cantidad, metodoPago } = req.body;
  const sagaId = uuidv4();
  const pedidoId = uuidv4();
  
  try {
    // Crear pedido en base de datos
    const result = await pool.query(
      'INSERT INTO pedidos (id, saga_id, usuario_id, producto_id, cantidad, estado) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      // ¡Aquí está el cambio!
      [pedidoId, sagaId, req.user.usuarioId, productoId, cantidad, SagaState.INICIADA] 
    )
    
    // Iniciar estado de Saga
    await pool.query(
      'INSERT INTO saga_estados (saga_id, paso, estado) VALUES ($1, $2, $3)',
      [sagaId, 'CREAR_PEDIDO', 'COMPLETADO']
    );
    
    // Enviar evento para reservar inventario
  await publishSagaEvent(sagaId, 'RESERVAR_INVENTARIO', {
    productoId,
    cantidad,
    pedidoId,
    metodoPago
  });
    
    logger.info('Pedido creado', { sagaId, pedidoId, userId: req.user.userId });
    
    res.status(201).json({
      pedidoId,
      sagaId,
      estado: SagaState.INICIADA
    });
    
  } catch (error) {
    logger.error('Error creando pedido', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint para consultar estado de Saga
app.get('/sagas/:sagaId', authenticateToken, async (req, res) => {
  try {
    const { sagaId } = req.params;
    
    const pedidoResult = await pool.query(
      'SELECT * FROM pedidos WHERE saga_id = $1',
      [sagaId]
    );
    
    const estadosResult = await pool.query(
      'SELECT * FROM saga_estados WHERE saga_id = $1 ORDER BY timestamp',
      [sagaId]
    );
    
    res.json({
      pedido: pedidoResult.rows[0],
      estados: estadosResult.rows
    });
    
  } catch (error) {
    logger.error('Error consultando saga', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Función para publicar eventos de Saga
async function publishSagaEvent(sagaId, evento, payload) {
  const message = {
    sagaId,
    evento,
    payload,
    timestamp: new Date().toISOString()
  };
  
  await channel.sendToQueue('saga_events', Buffer.from(JSON.stringify(message)));
  logger.info('Evento Saga publicado', { sagaId, evento });
}

// Consumir eventos de respuesta de otros servicios
async function consumeSagaEvents() {
  await channel.assertQueue('pedidos_responses', { durable: true });
  
  channel.consume('pedidos_responses', async (msg) => {
    const event = JSON.parse(msg.content.toString());
    await processSagaResponse(event);
    channel.ack(msg);
  });
}

// Procesar respuestas de la Saga
async function processSagaResponse(event) {
  const { sagaId, evento, success, payload } = event;
  
  logger.info('Procesando respuesta Saga', { sagaId, evento, success });
  
  try {
    switch (evento) {
      case 'INVENTARIO_RESERVADO':
        if (success) {
          await updateSagaState(sagaId, 'RESERVAR_INVENTARIO', 'COMPLETADO');
          await updatePedidoState(sagaId, SagaState.INVENTARIO_RESERVADO);
          // Procesar pago
          await publishSagaEvent(sagaId, 'PROCESAR_PAGO', payload);
        } else {
          await compensateSaga(sagaId, 'INVENTARIO_NO_DISPONIBLE');
        }
        break;
        
      case 'PAGO_PROCESADO':
        if (success) {
          await updateSagaState(sagaId, 'PROCESAR_PAGO', 'COMPLETADO');
          await updatePedidoState(sagaId, SagaState.PAGO_PROCESADO);
          // Confirmar pedido
          await publishSagaEvent(sagaId, 'CONFIRMAR_PEDIDO', payload);
        } else {
          await compensateSaga(sagaId, 'PAGO_RECHAZADO');
        }
        break;
        
      case 'PEDIDO_CONFIRMADO':
        await updateSagaState(sagaId, 'CONFIRMAR_PEDIDO', 'COMPLETADO');
        await updatePedidoState(sagaId, SagaState.COMPLETADA);
        break;
    }
  } catch (error) {
    logger.error('Error procesando respuesta Saga', error);
    await compensateSaga(sagaId, 'ERROR_INTERNO');
  }
}

// Actualizar estado de Saga
async function updateSagaState(sagaId, paso, estado) {
  await pool.query(
    'INSERT INTO saga_estados (saga_id, paso, estado) VALUES ($1, $2, $3)',
    [sagaId, paso, estado]
  );
}

// Actualizar estado del pedido
async function updatePedidoState(sagaId, estado) {
  await pool.query(
    'UPDATE pedidos SET estado = $1 WHERE saga_id = $2',
    [estado, sagaId]
  );
}

// Compensar Saga (rollback)
async function compensateSaga(sagaId, razon) {
  logger.warn('Iniciando compensación Saga', { sagaId, razon });
  
  await updatePedidoState(sagaId, SagaState.COMPENSANDO);
  
  // Publicar eventos de compensación
  await publishSagaEvent(sagaId, 'COMPENSAR_PAGO', { razon });
  await publishSagaEvent(sagaId, 'LIBERAR_INVENTARIO', { razon });
  
  await updatePedidoState(sagaId, SagaState.CANCELADA);
  await updateSagaState(sagaId, 'COMPENSACION', 'COMPLETADO');
}

// Login básico para JWT
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  // Validación básica (en producción usar hash)
  if (email === 'admin@tuso.com' && password === 'admin123') {
    const token = jwt.sign(
      { userId: 1, email, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, role: 'admin' });
  } else if (email === 'cliente@tuso.com' && password === 'cliente123') {
    const token = jwt.sign(
      { userId: 2, email, role: 'cliente' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, role: 'cliente' });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'pedidos', timestamp: new Date().toISOString() });
});

// Inicializar conexiones
async function initialize() {
  try {
    await connectRabbitMQ();
    await consumeSagaEvents();
    
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      logger.info(`Servicio de Pedidos ejecutándose en puerto ${PORT}`);
    });
    
  } catch (error) {
    logger.error('Error inicializando servicio', error);
    process.exit(1);
  }
}

initialize();