// services/inventario/src/app.js
const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const winston = require('winston');

const app = express();
app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'inventario.log' })
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
  
  // Consumir eventos de Saga
  channel.consume('saga_events', async (msg) => {
    const event = JSON.parse(msg.content.toString());
    if (event.evento === 'RESERVAR_INVENTARIO' || event.evento === 'LIBERAR_INVENTARIO') {
      await procesarEventoInventario(event);
    }
    channel.ack(msg);
  });
  
  logger.info('Inventario conectado a RabbitMQ');
}

async function procesarEventoInventario(event) {
  const { sagaId, evento, payload } = event;
  
  logger.info('Procesando evento inventario', { sagaId, evento });
  
  try {
    if (evento === 'RESERVAR_INVENTARIO') {
      const success = await reservarStock(sagaId, payload.productoId, payload.cantidad);
      await enviarRespuesta(sagaId, 'INVENTARIO_RESERVADO', success, payload);
      
    } else if (evento === 'LIBERAR_INVENTARIO') {
      await liberarStock(sagaId);
      logger.info('Stock liberado por compensación', { sagaId });
    }
    
  } catch (error) {
    logger.error('Error procesando evento inventario', error);
    await enviarRespuesta(sagaId, 'INVENTARIO_RESERVADO', false, { error: error.message });
  }
}

async function reservarStock(sagaId, productoId, cantidad) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Verificar stock disponible
    const stockResult = await client.query(
      'SELECT stock_disponible FROM productos WHERE id = $1 FOR UPDATE',
      [productoId]
    );
    
    if (stockResult.rows.length === 0) {
      throw new Error('Producto no encontrado');
    }
    
    const stockDisponible = stockResult.rows[0].stock_disponible;
    
    if (stockDisponible < cantidad) {
      logger.warn('Stock insuficiente', { productoId, solicitado: cantidad, disponible: stockDisponible });
      await client.query('ROLLBACK');
      return false;
    }
    
    // Reducir stock temporalmente
    await client.query(
      'UPDATE productos SET stock_disponible = stock_disponible - $1 WHERE id = $2',
      [cantidad, productoId]
    );
    
    // Crear reserva temporal (expira en 10 minutos)
    await client.query(
      'INSERT INTO reservas_temporales (saga_id, producto_id, cantidad_reservada, expira_en) VALUES ($1, $2, $3, $4)',
      [sagaId, productoId, cantidad, new Date(Date.now() + 10 * 60 * 1000)]
    );
    
    await client.query('COMMIT');
    logger.info('Stock reservado exitosamente', { sagaId, productoId, cantidad });
    return true;
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function liberarStock(sagaId) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Obtener reserva
    const reservaResult = await client.query(
      'SELECT * FROM reservas_temporales WHERE saga_id = $1 AND estado = $2',
      [sagaId, 'ACTIVA']
    );
    
    if (reservaResult.rows.length > 0) {
      const reserva = reservaResult.rows[0];
      
      // Devolver stock
      await client.query(
        'UPDATE productos SET stock_disponible = stock_disponible + $1 WHERE id = $2',
        [reserva.cantidad_reservada, reserva.producto_id]
      );
      
      // Marcar reserva como liberada
      await client.query(
        'UPDATE reservas_temporales SET estado = $1 WHERE saga_id = $2',
        ['LIBERADA', sagaId]
      );
    }
    
    await client.query('COMMIT');
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function enviarRespuesta(sagaId, evento, success, payload) {
  const response = {
    sagaId,
    evento,
    success,
    payload,
    timestamp: new Date().toISOString(),
    servicio: 'inventario'
  };
  
  await channel.sendToQueue('pedidos_responses', Buffer.from(JSON.stringify(response)));
  logger.info('Respuesta enviada', { sagaId, evento, success });
}

// Endpoint para consultar productos
app.get('/productos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM productos WHERE stock_disponible > 0');
    res.json(result.rows);
  } catch (error) {
    logger.error('Error consultando productos', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'inventario', timestamp: new Date().toISOString() });
});

// Limpiar reservas expiradas cada 5 minutos
setInterval(async () => {
  try {
    const result = await pool.query(
      'UPDATE reservas_temporales SET estado = $1 WHERE expira_en < NOW() AND estado = $2',
      ['EXPIRADA', 'ACTIVA']
    );
    
    if (result.rowCount > 0) {
      // Devolver stock de reservas expiradas
      await pool.query(`
        UPDATE productos 
        SET stock_disponible = stock_disponible + rt.cantidad_reservada
        FROM reservas_temporales rt
        WHERE rt.producto_id = productos.id 
          AND rt.estado = 'EXPIRADA'
          AND rt.expira_en > NOW() - INTERVAL '1 minute'
      `);
      
      logger.info('Reservas expiradas limpiadas', { cantidad: result.rowCount });
    }
  } catch (error) {
    logger.error('Error limpiando reservas expiradas', error);
  }
}, 5 * 60 * 1000);

async function initialize() {
  try {
    await connectRabbitMQ();
    
    const PORT = process.env.PORT || 3002;
    app.listen(PORT, () => {
      logger.info(`Servicio de Inventario ejecutándose en puerto ${PORT}`);
    });
    
  } catch (error) {
    logger.error('Error inicializando servicio', error);
    process.exit(1);
  }
}

initialize();