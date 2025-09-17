// services/pagos/src/app.js
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'pagos.log' })
  ]
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432
});

let channel;

async function connectRabbitMQ() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  
  await channel.assertQueue('saga_events', { durable: true });
  await channel.assertQueue('pedidos_responses', { durable: true });
  
  channel.consume('saga_events', async (msg) => {
    const event = JSON.parse(msg.content.toString());
    if (event.evento === 'PROCESAR_PAGO' || event.evento === 'COMPENSAR_PAGO') {
      await procesarEventoPago(event);
    }
    channel.ack(msg);
  });
  
  logger.info('Pagos conectado a RabbitMQ');
}

async function procesarEventoPago(event) {
  const { sagaId, evento, payload } = event;
  
  logger.info('Procesando evento pago', { sagaId, evento });
  
  try {
    if (evento === 'PROCESAR_PAGO') {
      const success = await procesarPago(sagaId, payload);
      await enviarRespuesta(sagaId, 'PAGO_PROCESADO', success, payload);
      
    } else if (evento === 'COMPENSAR_PAGO') {
      await compensarPago(sagaId);
      logger.info('Pago compensado', { sagaId });
    }
    
  } catch (error) {
    logger.error('Error procesando evento pago', error);
    await enviarRespuesta(sagaId, 'PAGO_PROCESADO', false, { error: error.message });
  }
}

async function procesarPago(sagaId, payload) {
  const transactionId = uuidv4();
  const { productoId, cantidad, metodoPago } = payload;
  
  try {
    // Simular validación de método de pago
    const metodosValidos = ['tarjeta_credito', 'tarjeta_debito', 'pse', 'efectivo'];
    if (!metodosValidos.includes(metodoPago)) {
      logger.warn('Método de pago no válido', { metodoPago, sagaId });
      return false;
    }
    
    // Obtener precio del producto (simulado)
    const precio = await obtenerPrecioProducto(productoId);
    const montoTotal = precio * cantidad;
    
    // Simular procesamiento de pago (90% éxito, 10% falla)
    const exitoso = Math.random() > 0.1;
    
    // Guardar transacción en base de datos
    await pool.query(
      'INSERT INTO transacciones (transaction_id, saga_id, monto, metodo_pago, estado, referencia_externa) VALUES ($1, $2, $3, $4, $5, $6)',
      [transactionId, sagaId, montoTotal, metodoPago, exitoso ? 'APROBADA' : 'RECHAZADA', `REF-${Date.now()}`]
    );
    
    if (exitoso) {
      logger.info('Pago procesado exitosamente', { 
        sagaId, 
        transactionId, 
        monto: montoTotal,
        metodoPago 
      });
    } else {
      logger.warn('Pago rechazado por simulación', { sagaId, transactionId });
    }
    
    return exitoso;
    
  } catch (error) {
    logger.error('Error procesando pago', error);
    return false;
  }
}

async function obtenerPrecioProducto(productoId) {
  // Simulación de precios (en producción consultaría el servicio de catálogo)
  const precios = {
    1: 450000.00, // Cartagena
    2: 180000.00, // Cocora
    3: 85000.00,  // Bogotá
    4: 890000.00  // San Andrés
  };
  
  return precios[productoId] || 100000.00;
}

async function compensarPago(sagaId) {
  try {
    // Buscar transacción aprobada para esta saga
    const result = await pool.query(
      'SELECT * FROM transacciones WHERE saga_id = $1 AND estado = $2',
      [sagaId, 'APROBADA']
    );
    
    if (result.rows.length > 0) {
      const transaccion = result.rows[0];
      
      // Simular reversión del pago
      await pool.query(
        'UPDATE transacciones SET estado = $1 WHERE transaction_id = $2',
        ['REVERTIDA', transaccion.transaction_id]
      );
      
      logger.info('Pago revertido por compensación', { 
        sagaId, 
        transactionId: transaccion.transaction_id,
        monto: transaccion.monto
      });
    }
    
  } catch (error) {
    logger.error('Error compensando pago', error);
    throw error;
  }
}

async function enviarRespuesta(sagaId, evento, success, payload) {
  const response = {
    sagaId,
    evento,
    success,
    payload,
    timestamp: new Date().toISOString(),
    servicio: 'pagos'
  };
  
  await channel.sendToQueue('pedidos_responses', Buffer.from(JSON.stringify(response)));
  logger.info('Respuesta enviada', { sagaId, evento, success });
}

// Endpoints REST para consultas
app.get('/transacciones/:sagaId', async (req, res) => {
  try {
    const { sagaId } = req.params;
    const result = await pool.query(
      'SELECT * FROM transacciones WHERE saga_id = $1',
      [sagaId]
    );
    res.json(result.rows);
  } catch (error) {
    logger.error('Error consultando transacciones', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/metodos-pago', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM metodos_pago WHERE activo = true');
    res.json(result.rows);
  } catch (error) {
    logger.error('Error consultando métodos de pago', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'pagos', timestamp: new Date().toISOString() });
});

async function initialize() {
  try {
    await connectRabbitMQ();
    
    const PORT = process.env.PORT || 3003;
    app.listen(PORT, () => {
      logger.info(`Servicio de Pagos ejecutándose en puerto ${PORT}`);
    });
    
  } catch (error) {
    logger.error('Error inicializando servicio', error);
    process.exit(1);
  }
}

initialize();