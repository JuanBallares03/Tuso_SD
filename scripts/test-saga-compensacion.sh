# scripts/test-saga-compensacion.sh
#!/bin/bash

echo "=== PRUEBA DE SAGA CON COMPENSACIÓN ==="

TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@tuso.com","password":"admin123"}' | \
  jq -r '.token')

echo "Creando pedido que debería fallar (cantidad muy alta)..."
SAGA_RESPONSE=$(curl -s -X POST http://localhost:3001/pedidos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"productoId":1,"cantidad":999,"metodoPago":"tarjeta_credito"}')

echo "Respuesta: $SAGA_RESPONSE"

SAGA_ID=$(echo $SAGA_RESPONSE | jq -r '.sagaId')

sleep 5

echo "Estado final (debería mostrar compensación):"
curl -s -X GET "http://localhost:3001/sagas/$SAGA_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '.'