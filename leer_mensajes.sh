#!/bin/bash

# Script para leer mensajes de WhatsApp usando Evolution API
# Uso: ./leer_mensajes.sh [INSTANCIA] [NUMERO] [CANTIDAD]
# Ejemplos:
#   ./leer_mensajes.sh                           # Últimos 20 mensajes de la instancia por defecto
#   ./leer_mensajes.sh Javier                    # Últimos 20 mensajes de instancia Javier
#   ./leer_mensajes.sh Javier 5491112345678      # Mensajes con un contacto específico
#   ./leer_mensajes.sh Javier 5491112345678 50   # Últimos 50 mensajes con un contacto

# Configuración
API_URL="http://localhost:8081"
API_KEY="429683C4C977415CAAFCCE10F7D57E11"
DEFAULT_INSTANCE="Javier"

# Colores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parsear argumentos
INSTANCE_NAME="${1:-$DEFAULT_INSTANCE}"
REMOTE_JID="${2:-}"
COUNT="${3:-20}"

echo -e "${YELLOW}📨 Leyendo mensajes...${NC}"
echo "Instancia: $INSTANCE_NAME"
if [ -n "$REMOTE_JID" ]; then
    echo "Contacto: $REMOTE_JID"
fi
echo "Cantidad: $COUNT"
echo ""

# Construir el body del request
if [ -n "$REMOTE_JID" ]; then
    # Mensajes de un contacto específico
    BODY="{
        \"where\": {
            \"key\": {
                \"remoteJid\": \"${REMOTE_JID}@s.whatsapp.net\"
            }
        },
        \"limit\": $COUNT
    }"
else
    # Todos los mensajes
    BODY="{
        \"where\": {},
        \"limit\": $COUNT
    }"
fi

# Obtener mensajes
RESPONSE=$(curl -s -X POST "$API_URL/chat/findMessages/$INSTANCE_NAME" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "$BODY")

# Verificar si hay error
if echo "$RESPONSE" | grep -q '"error"'; then
    echo -e "${RED}❌ Error al obtener mensajes${NC}"
    echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
    exit 1
fi

# Mostrar mensajes formateados
echo -e "${GREEN}✅ Mensajes obtenidos:${NC}"
echo ""

# Formatear con jq si está disponible
if command -v jq &> /dev/null; then
    echo "$RESPONSE" | jq -r '.[] | 
        "───────────────────────────────────────────────────────────────
📱 De: \(.key.remoteJid // "Desconocido")
⏰ Fecha: \(.messageTimestamp // "Sin fecha")
💬 Mensaje: \(.message.conversation // .message.extendedTextMessage.text // .message.imageMessage.caption // "[Mensaje multimedia]")
📤 Enviado por mí: \(.key.fromMe // false)"' 2>/dev/null
    
    # Mostrar conteo
    TOTAL=$(echo "$RESPONSE" | jq 'length' 2>/dev/null)
    echo ""
    echo "───────────────────────────────────────────────────────────────"
    echo -e "${CYAN}Total de mensajes: $TOTAL${NC}"
else
    # Sin jq, mostrar JSON crudo
    echo "$RESPONSE"
fi
