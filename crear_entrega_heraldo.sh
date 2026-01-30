#!/bin/bash

# =============================================================================
# CREAR ENTREGA PARA HERALDO - Evolution API Delivery Tracking
# =============================================================================
# 
# Este script crea una entrega de prueba para Heraldo.
#
# USO: ./crear_entrega_heraldo.sh
# =============================================================================

API_URL="http://167.71.214.252:8081"
API_KEY="429683C4C977415CAAFCCE10F7D57E11"
INSTANCE="javier"

curl -s -X POST "${API_URL}/delivery/create/${INSTANCE}" \
  -H "apikey: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "idPesada": "ENTREGA_HERALDO_01",
    "phoneNumber": "5493412801015",
    "choferNombre": "Heraldo",
    "patente": "ABC123",
    "artNombre": "Soja",
    "origen": "Campo Las Rosas",
    "pesoNeto": 30000,
    "pesoUn": "kg",
    "ubicaciones": [
      {"orden": 1, "nombre": "Depósito Norte", "direccion": "Ruta 9 km 150"},
      {"orden": 2, "nombre": "Acopio Central", "direccion": "Av. Industrial 500"},
      {"orden": 3, "nombre": "Planta Sur", "direccion": "Calle 10 N° 200"}
    ]
  }' | jq '.'

echo ""
echo "✅ Entrega creada para Heraldo. Recibirá un mensaje de WhatsApp."
