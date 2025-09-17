// services/catalogo/src/app.js
const express = require('express');
const { Pool } = require('pg');
const winston = require('winston');

const app = express();
app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'catalogo.log' })
  ]
});

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432
});

// Cache simple en memoria
let productosCache = null;
let cacheExpiry = null;

// Obtener todos los productos/destinos
app.get('/productos', async (req, res) => {
  try {
    // Cache de 5 minutos
    if (productosCache && cacheExpiry > Date.now()) {
      return res.json(productosCache);
    }
    
    const result = await pool.query(`
      SELECT 
        d.id,
        d.nombre,
        d.descripcion,
        d.ubicacion,
        d.precio_base as precio,
        d.activo,
        ARRAY_AGG(c.nombre) as categorias
      FROM destinos d
      LEFT JOIN destino_categorias dc ON d.id = dc.destino_id
      LEFT JOIN categorias c ON dc.categoria_id = c.id
      WHERE d.activo = true
      GROUP BY d.id, d.nombre, d.descripcion, d.ubicacion, d.precio_base, d.activo
      ORDER BY d.nombre
    `);
    
    productosCache = result.rows;
    cacheExpiry = Date.now() + (5 * 60 * 1000); // 5 minutos
    
    logger.info('Productos consultados', { cantidad: result.rows.length });
    res.json(result.rows);
    
  } catch (error) {
    logger.error('Error consultando productos', error);
    res.status(500).json({ error: 'Error consultando productos' });
  }
});

// Obtener producto específico
app.get('/productos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT 
        d.id,
        d.nombre,
        d.descripcion,
        d.ubicacion,
        d.precio_base as precio,
        d.activo,
        JSON_AGG(
          JSON_BUILD_OBJECT('id', c.id, 'nombre', c.nombre, 'descripcion', c.descripcion)
        ) as categorias
      FROM destinos d
      LEFT JOIN destino_categorias dc ON d.id = dc.destino_id
      LEFT JOIN categorias c ON dc.categoria_id = c.id
      WHERE d.id = $1 AND d.activo = true
      GROUP BY d.id, d.nombre, d.descripcion, d.ubicacion, d.precio_base, d.activo
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    logger.info('Producto consultado', { id, nombre: result.rows[0].nombre });
    res.json(result.rows[0]);
    
  } catch (error) {
    logger.error('Error consultando producto', error);
    res.status(500).json({ error: 'Error consultando producto' });
  }
});

// Obtener categorías
app.get('/categorias', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categorias ORDER BY nombre');
    res.json(result.rows);
    
  } catch (error) {
    logger.error('Error consultando categorías', error);
    res.status(500).json({ error: 'Error consultando categorías' });
  }
});

// Filtrar productos por categoría
app.get('/productos/categoria/:categoriaId', async (req, res) => {
  try {
    const { categoriaId } = req.params;
    
    const result = await pool.query(`
      SELECT 
        d.id,
        d.nombre,
        d.descripcion,
        d.ubicacion,
        d.precio_base as precio,
        d.activo
      FROM destinos d
      JOIN destino_categorias dc ON d.id = dc.destino_id
      WHERE dc.categoria_id = $1 AND d.activo = true
      ORDER BY d.nombre
    `, [categoriaId]);
    
    logger.info('Productos filtrados por categoría', { categoriaId, cantidad: result.rows.length });
    res.json(result.rows);
    
  } catch (error) {
    logger.error('Error filtrando productos', error);
    res.status(500).json({ error: 'Error filtrando productos' });
  }
});

// Búsqueda de productos
app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Término de búsqueda debe tener al menos 2 caracteres' });
    }
    
    const searchTerm = `%${q.toLowerCase()}%`;
    
    const result = await pool.query(`
      SELECT 
        d.id,
        d.nombre,
        d.descripcion,
        d.ubicacion,
        d.precio_base as precio,
        d.activo
      FROM destinos d
      WHERE d.activo = true 
        AND (LOWER(d.nombre) LIKE $1 OR LOWER(d.descripcion) LIKE $1 OR LOWER(d.ubicacion) LIKE $1)
      ORDER BY 
        CASE 
          WHEN LOWER(d.nombre) LIKE $1 THEN 1
          WHEN LOWER(d.ubicacion) LIKE $1 THEN 2
          ELSE 3
        END,
        d.nombre
      LIMIT 20
    `, [searchTerm]);
    
    logger.info('Búsqueda realizada', { termino: q, resultados: result.rows.length });
    res.json(result.rows);
    
  } catch (error) {
    logger.error('Error en búsqueda', error);
    res.status(500).json({ error: 'Error en búsqueda' });
  }
});

// Estadísticas básicas
app.get('/stats', async (req, res) => {
  try {
    const [productosResult, categoriasResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN activo = true THEN 1 END) as activos FROM destinos'),
      pool.query('SELECT COUNT(*) as total FROM categorias')
    ]);
    
    const stats = {
      productos: {
        total: parseInt(productosResult.rows[0].total),
        activos: parseInt(productosResult.rows[0].activos)
      },
      categorias: {
        total: parseInt(categoriasResult.rows[0].total)
      },
      cache: {
        activo: productosCache !== null,
        expira: cacheExpiry
      }
    };
    
    res.json(stats);
    
  } catch (error) {
    logger.error('Error consultando estadísticas', error);
    res.status(500).json({ error: 'Error consultando estadísticas' });
  }
});

// Limpiar cache manualmente
app.post('/cache/clear', (req, res) => {
  productosCache = null;
  cacheExpiry = null;
  logger.info('Cache limpiado manualmente');
  res.json({ message: 'Cache limpiado' });
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Verificar conexión a base de datos
    await pool.query('SELECT 1');
    
    res.json({ 
      status: 'OK', 
      service: 'catalogo', 
      timestamp: new Date().toISOString(),
      cache: {
        activo: productosCache !== null,
        productos: productosCache?.length || 0
      }
    });
  } catch (error) {
    logger.error('Health check fallido', error);
    res.status(500).json({ 
      status: 'ERROR', 
      service: 'catalogo', 
      error: error.message 
    });
  }
});

// Middleware de manejo de errores
app.use((error, req, res, next) => {
  logger.error('Error no manejado', error);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Limpiar cache automáticamente cada 5 minutos
setInterval(() => {
  productosCache = null;
  cacheExpiry = null;
  logger.info('Cache limpiado automáticamente');
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  logger.info(`Servicio de Catálogo ejecutándose en puerto ${PORT}`);
});