# TUSO - Sistema Distribuido con Patrón Saga

Sistema de reservas turísticas implementando arquitectura de microservicios con patrón Saga orquestado.

## Arquitectura

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   PEDIDOS       │    │   INVENTARIO    │    │     PAGOS       │    │   CATÁLOGO      │
│ (Orquestador)   │◄──►│   (Stock)       │◄──►│  (Simulado)     │◄──►│ (Solo Lectura)  │
│                 │    │                 │    │                 │    │                 │
│ Puerto: 3001    │    │ Puerto: 3002    │    │ Puerto: 3003    │    │ Puerto: 3004    │
└─────────────────┘    └─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │                       │
         └───────────────────────┼───────────────────────┼───────────────────────┘
                                 │                       │
                          ┌─────────────────┐           │
                          │   PostgreSQL    │◄──────────┘
                          │   (Multi DB)    │
                          └─────────────────┘
                                 │
                          ┌─────────────────┐
                          │   RabbitMQ      │
                          │  (Mensajería)   │
                          └─────────────────┘
```

## Requisitos

- Docker y Docker Compose
- Node.js 18+ (para desarrollo)
- Git

## Instalación y Ejecución

### 1. Clonar repositorio
```bash
git clone https://github.com/JuanBallares03/Tuso_SD
cd Tuso_SD
```

### 2. Levantar sistema completo
```bash
# Construir y levantar todos los servicios
docker-compose up --build

# En modo detached (background)
docker-compose up --build -d
```

### 3. Verificar estado
```bash
# Ver logs de todos los servicios
docker-compose logs -f

# Ver estado de contenedores
docker-compose ps

# Logs específicos
docker-compose logs -f pedidos-service
```

## Endpoints Disponibles

### Autenticación
```bash
# Login (obtener JWT)
curl -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@tuso.com",
    "password": "admin123"
  }'

# Respuesta: { "token": "jwt-token", "role": "admin" }
```

### Pedidos (Saga Orquestador)
```bash
# Crear pedido (inicia Saga)
curl -X POST http://localhost:3001/pedidos \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "productoId": 1,
    "cantidad": 2,
    "metodoPago": "tarjeta_credito"
  }'

# Consultar estado de Saga
curl -X GET http://localhost:3001/sagas/SAGA_ID \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Servicios individuales
```bash
# Health checks
curl http://localhost:3001/health  # Pedidos
curl http://localhost:3002/health  # Inventario
curl http://localhost:3003/health  # Pagos
curl http://localhost:3004/health  # Catálogo

# Catálogo (productos disponibles)
curl http://localhost:3004/productos
```

## Flujo de la Saga

1. **Cliente crea pedido** → `POST /pedidos`
2. **Pedidos reserva inventario** → Mensaje a `inventario-service`
3. **Inventario confirma/rechaza** → Respuesta a `pedidos-service`
4. **Pedidos procesa pago** → Mensaje a `pagos-service`
5. **Pagos confirma/rechaza** → Respuesta a `pedidos-service`
6. **Pedidos confirma pedido** → Saga completada

### En caso de error (Compensación):
- **Liberar inventario reservado**
- **Revertir transacción de pago**
- **Cancelar pedido**

## Monitoreo

### RabbitMQ Management
```
URL: http://localhost:15672
User: tuso
Pass: password123
```

### PostgreSQL
```bash
# Conectar a base de datos
docker exec -it tuso-distributed-system_postgres_1 psql -U tuso -d pedidos_db

# Ver tablas
\dt

# Consultar pedidos
SELECT * FROM pedidos;

# Ver estados de Saga
SELECT * FROM saga_estados ORDER BY timestamp DESC;
```

## Estructura del Proyecto

```
tuso-distributed-system/
├── docker-compose.yml
├── README.md
├── scripts/
│   └── init-db.sql
└── services/
    ├── pedidos/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── src/
    ├── inventario/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── src/
    ├── pagos/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── src/
    └── catalogo/
        ├── Dockerfile
        ├── package.json
        └── src/
```

## Usuarios de Prueba

### Admin
- Email: `admin@tuso.com`
- Password: `admin123`
- Role: `admin`

### Cliente
- Email: `cliente@tuso.com`
- Password: `cliente123`
- Role: `cliente`

## Productos de Prueba

| ID | Producto | Stock | Precio |
|----|----------|-------|---------|
| 1 | Paquete Turístico Cartagena | 10 | $450,000 |
| 2 | Aventura en Cocora | 15 | $180,000 |
| 3 | City Tour Bogotá | 20 | $85,000 |
| 4 | Playa y Sol San Andrés | 8 | $890,000 |

## Ejemplo Completo de Uso

```bash
# 1. Levantar sistema
docker-compose up --build -d

# 2. Login
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tuso.com","password":"admin123"}' | \
  jq -r '.token')

# 3. Ver catálogo
curl http://localhost:3004/productos

# 4. Crear pedido
SAGA_RESPONSE=$(curl -s -X POST http://localhost:3001/pedidos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productoId":1,"cantidad":2,"metodoPago":"tarjeta_credito"}')

echo "Respuesta: $SAGA_RESPONSE"

# 5. Extraer sagaId y consultar estado
SAGA_ID=$(echo $SAGA_RESPONSE | jq -r '.sagaId')
curl -X GET http://localhost:3001/sagas/$SAGA_ID \
  -H "Authorization: Bearer $TOKEN"
```

## Troubleshooting

### Problemas Comunes

**Error: Port already in use**
```bash
# Detener servicios existentes
docker-compose down
# Limpiar contenedores
docker system prune -f
# Reintentar
docker-compose up --build
```

**Base de datos no inicializa**
```bash
# Eliminar volumen de PostgreSQL
docker-compose down -v
# Reconstruir
docker-compose up --build
```

**RabbitMQ no conecta**
```bash
# Verificar logs
docker-compose logs rabbitmq
# Esperar 30 segundos después del arranque
```

**JWT Token inválido**
```bash
# Verificar que el token no haya expirado (24h)
# Volver a hacer login
```

### Comandos de Limpieza

```bash
# Detener todo
docker-compose down

# Detener y eliminar volúmenes
docker-compose down -v

# Limpiar todo Docker
docker system prune -a
```

## Desarrollo

### Estructura de cada servicio

```
services/[servicio]/
├── Dockerfile
├── package.json
├── src/
│   ├── app.js          # Servidor principal
│   ├── config/         # Configuración
│   ├── controllers/    # Lógica de negocio
│   ├── routes/         # Rutas HTTP
│   └── utils/          # Utilidades
└── .dockerignore
```

### Agregar nuevo endpoint

1. Editar `services/[servicio]/src/app.js`
2. Reconstruir servicio: `docker-compose build [servicio]-service`
3. Reiniciar: `docker-compose up -d [servicio]-service`

## Testing

### Prueba de Saga exitosa
```bash
# Login y crear pedido con stock disponible
./scripts/test-saga-exitosa.sh
```

### Prueba de compensación
```bash
# Crear pedido que falle (sin stock o pago rechazado)
./scripts/test-saga-compensacion.sh
```

## Características Implementadas

- ✅ **4 Microservicios** con bases de datos independientes
- ✅ **Patrón Saga orquestado** con compensación automática
- ✅ **Mensajería RabbitMQ** para comunicación asíncrona
- ✅ **JWT Authentication** con roles básicos
- ✅ **Idempotencia** en operaciones críticas
- ✅ **Logging centralizado** con Winston
- ✅ **Health checks** en todos los servicios
- ✅ **Docker Compose** para despliegue reproducible
- ✅ **Base de datos PostgreSQL** con múltiples esquemas
- ✅ **Patrón Outbox** simulado en eventos

## Próximas Mejoras (Corte 2)

- Circuit Breakers con Hystrix
- Service Discovery con Consul
- Métricas con Prometheus/Grafana
- Tracing distribuido con Jaeger
- Cache con Redis
- API Gateway con Kong

## Licencia

Este proyecto es para fines académicos - UNIMINUTO 2024