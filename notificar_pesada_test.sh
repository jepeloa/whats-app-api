#!/bin/bash

# =============================================================================
# TEST NOTIFICACIÓN DE PESADA - Evolution API
# =============================================================================
#
# Consulta SQL Server por IdPesada, arma el mensaje y lo envía al teléfono
# de test (NO al chofer real).
#
# USO: ./notificar_pesada_test.sh [ID_PESADA] [TELEFONO_TEST]
# Ejemplo: ./notificar_pesada_test.sh 29352 5493413924283
# =============================================================================

API_URL="http://167.71.214.252:8085"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"
INSTANCE="POC-test-sibila"

ID_PESADA=${1:-29352}
TEST_PHONE=${2:-5493413924283}

echo "Notificando pesada ${ID_PESADA} al teléfono de test ${TEST_PHONE}..."
echo ""

curl -s -X POST "${API_URL}/delivery/notify-test/${ID_PESADA}/${INSTANCE}" \
  -H "apikey: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"testPhone\": \"${TEST_PHONE}\"
  }" | jq '.'

echo ""
echo "✅ Test completado."
