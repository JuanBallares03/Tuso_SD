-- Crear bases de datos para cada servicio
CREATE DATABASE pedidos_db;
CREATE DATABASE inventario_db;
CREATE DATABASE pagos_db;
CREATE DATABASE catalogo_db;

-- Conectar a pedidos_db
\c pedidos_db;

-- Tablas para servicio de Pedidos
CREATE TABLE pedidos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    saga_id UUID NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL,
    producto_id INTEGER NOT NULL,
    cantidad INTEGER NOT NULL,
    monto_total DECIMAL(10,2),
    estado VARCHAR(50) DEFAULT 'INICIADA',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE saga_estados (
    id SERIAL PRIMARY KEY,
    saga_id UUID NOT NULL,
    paso VARCHAR(50) NOT NULL,
    estado VARCHAR(20) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    payload JSONB,
    error_message TEXT
);

CREATE INDEX idx_pedidos_saga_id ON pedidos(saga_id);
CREATE INDEX idx_saga_estados_saga_id ON saga_estados(saga_id);

-- Conectar a inventario_db
\c inventario_db;

-- Tablas para servicio de Inventario
CREATE TABLE productos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    descripcion TEXT,
    stock_disponible INTEGER NOT NULL DEFAULT 0,
    precio DECIMAL(10,2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reservas_temporales (
    id SERIAL PRIMARY KEY,
    saga_id UUID NOT NULL,
    producto_id INTEGER NOT NULL,
    cantidad_reservada INTEGER NOT NULL,
    expira_en TIMESTAMP NOT NULL,
    estado VARCHAR(20) DEFAULT 'ACTIVA',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (producto_id) REFERENCES productos(id)
);

-- Datos de prueba para inventario
INSERT INTO productos (nombre, descripcion, stock_disponible, precio) VALUES
('Paquete Turístico Cartagena', 'Tour completo por Cartagena 3 días', 10, 450000.00),
('Aventura en Cocora', 'Senderismo Valle del Cocora', 15, 180000.00),
('City Tour Bogotá', 'Recorrido histórico por Bogotá', 20, 85000.00),
('Playa y Sol San Andrés', 'Paquete 4 días en San Andrés', 8, 890000.00);

CREATE INDEX idx_reservas_temp_saga_id ON reservas_temporales(saga_id);
CREATE INDEX idx_reservas_temp_expira ON reservas_temporales(expira_en);

-- Conectar a pagos_db
\c pagos_db;

-- Tablas para servicio de Pagos
CREATE TABLE transacciones (
    id SERIAL PRIMARY KEY,
    transaction_id UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    saga_id UUID NOT NULL,
    monto DECIMAL(10,2) NOT NULL,
    metodo_pago VARCHAR(50) NOT NULL,
    estado VARCHAR(20) DEFAULT 'PENDIENTE',
    referencia_externa VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE metodos_pago (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL,
    activo BOOLEAN DEFAULT true
);

-- Datos de prueba para métodos de pago
INSERT INTO metodos_pago (tipo, activo) VALUES
('tarjeta_credito', true),
('tarjeta_debito', true),
('pse', true),
('efectivo', true);

CREATE INDEX idx_transacciones_saga_id ON transacciones(saga_id);

-- Conectar a catalogo_db  
\c catalogo_db;

-- Tablas para servicio de Catálogo (solo lectura)
CREATE TABLE destinos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    descripcion TEXT,
    ubicacion VARCHAR(255),
    precio_base DECIMAL(10,2),
    activo BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categorias (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT
);

CREATE TABLE destino_categorias (
    destino_id INTEGER REFERENCES destinos(id),
    categoria_id INTEGER REFERENCES categorias(id),
    PRIMARY KEY (destino_id, categoria_id)
);

-- Datos de prueba para catálogo
INSERT INTO categorias (nombre, descripcion) VALUES
('Playa', 'Destinos costeros y playeros'),
('Aventura', 'Turismo de aventura y deportes extremos'),
('Cultural', 'Sitios históricos y culturales'),
('Urbano', 'City tours y turismo urbano');

INSERT INTO destinos (nombre, descripcion, ubicacion, precio_base, activo) VALUES
('Cartagena de Indias', 'Ciudad amurallada patrimonio de la humanidad', 'Cartagena, Bolívar', 450000.00, true),
('Valle del Cocora', 'Hogar de las palmas de cera más altas del mundo', 'Salento, Quindío', 180000.00, true),
('Centro Histórico Bogotá', 'La Candelaria y sitios emblemáticos', 'Bogotá D.C.', 85000.00, true),
('Archipiélago San Andrés', 'Mar de siete colores', 'San Andrés y Providencia', 890000.00, true);

INSERT INTO destino_categorias (destino_id, categoria_id) VALUES
(1, 3), (1, 1),  -- Cartagena: Cultural y Playa
(2, 2),          -- Cocora: Aventura  
(3, 3), (3, 4),  -- Bogotá: Cultural y Urbano
(4, 1);          -- San Andrés: Playa