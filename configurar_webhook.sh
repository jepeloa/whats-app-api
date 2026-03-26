#!/bin/bash

# Script para configurar el webhook de una instancia
# Uso: ./configurar_webhook.sh [INSTANCIA] [WEBHOOK_URL]
# Ejemplo: ./configurar_webhook.sh Javier http://localhost:5000/webhook

# Configuración
API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"
DEFAULT_INSTANCE="Javier"
DEFAULT_WEBHOOK_URL="http://localhost:5000/webhook"

# Colores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parsear argumentos
INSTANCE_NAME="${1:-$DEFAULT_INSTANCE}"
WEBHOOK_URL="${2:-$DEFAULT_WEBHOOK_URL}"

echo -e "${YELLOW}🔧 Configurando webhook...${NC}"
echo "Instancia: $INSTANCE_NAME"
echo "Webhook URL: $WEBHOOK_URL"
echo ""

# Configurar webhook
RESPONSE=$(curl -s -X POST "$API_URL/webhook/set/$INSTANCE_NAME" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "{
    \"url\": \"$WEBHOOK_URL\",
    \"enabled\": true,
    \"webhookByEvents\": false,
    \"webhookBase64\": false,
    \"events\": [
        \"MESSAGES_UPSERT\",
        \"MESSAGES_UPDATE\",
        \"MESSAGES_DELETE\",
        \"SEND_MESSAGE\",
        \"CONNECTION_UPDATE\",
        \"CONTACTS_UPSERT\",
        \"CHATS_UPSERT\",
        \"PRESENCE_UPDATE\",
        \"CALL\"
    ]
  }")

# Verificar respuesta
if echo "$RESPONSE" | grep -q '"error"'; then
    echo -e "${RED}❌ Error al configurar webhook${NC}"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
    exit 1
else
    echo -e "${GREEN}✅ Webhook configurado correctamente${NC}"
    echo ""
    echo "Configuración aplicada:"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
    echo ""
    echo -e "${YELLOW}📝 Próximos pasos:${NC}"
    echo "1. Ejecuta el receptor de webhooks: python3 webhook_receiver.py"
    echo "2. Los mensajes entrantes aparecerán en la consola"
fi
