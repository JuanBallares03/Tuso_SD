# scripts/test-saga-exitosa.sh
#!/bin/bash

echo "=== PRUEBA DE SAGA EXITOSA ==="

# Login
echo "1. Realizando login..."
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tuso.com","password":"admin123"}' | \
  jq -r '.token')

if [ "$TOKEN" = "null" ] || [ -z "$TOKEN" ]; then
  echo "❌ Error en login"
  exit 1
fi
echo "✅ Login exitoso"

# Ver productos disponibles
echo "2. Consultando productos..."
curl -s http://localhost:3004/productos | jq '.[0:3]'

# Crear pedido
echo "3. Creando pedido..."
SAGA_RESPONSE=$(curl -s -X POST http://localhost:3001/pedidos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productoId":1,"cantidad":2,"metodoPago":"tarjeta_credito"}')

echo "Respuesta: $SAGA_RESPONSE"

SAGA_ID=$(echo $SAGA_RESPONSE | jq -r '.sagaId')

if [ "$SAGA_ID" = "null" ]; then
  echo "❌ Error creando pedido"
  exit 1
fi

echo "✅ Pedido creado con sagaId: $SAGA_ID"

# Esperar procesamiento
echo "4. Esperando procesamiento de la saga..."
sleep 5

# Consultar estado final
echo "5. Consultando estado final..."
curl -s -X GET "http://localhost:3001/sagas/$SAGA_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.'

echo "=== PRUEBA COMPLETADA ==="