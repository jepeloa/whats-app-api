#!/bin/bash

# Script para enviar mensajes por WhatsApp usando Evolution API
# Uso: ./enviar_mensaje.sh INSTANCIA NUMERO "MENSAJE"
# Ejemplo: ./enviar_mensaje.sh Javier 5491112345678 "Hola, ¿cómo estás?"
# Si no especificas instancia, usa "Javier" por defecto

# Configuración
API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"
DEFAULT_INSTANCE="Javier"

# Colores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Verificar argumentos
if [ $# -eq 2 ]; then
    # Modo: ./enviar_mensaje.sh NUMERO "MENSAJE"
    INSTANCE_NAME="$DEFAULT_INSTANCE"
    NUMERO=$1
    MENSAJE=$2
elif [ $# -eq 3 ]; then
    # Modo: ./enviar_mensaje.sh INSTANCIA NUMERO "MENSAJE"
    INSTANCE_NAME=$1
    NUMERO=$2
    MENSAJE=$3
else
    echo -e "${RED}Error: Argumentos incorrectos${NC}"
    echo ""
    echo "Uso opción 1: $0 NUMERO \"MENSAJE\""
    echo "Uso opción 2: $0 INSTANCIA NUMERO \"MENSAJE\""
    echo ""
    echo "Ejemplos:"
    echo "  $0 5491112345678 \"Hola, ¿cómo estás?\""
    echo "  $0 Javier 5491112345678 \"Hola desde Javier\""
    echo "  $0 WhatsApp_2 543413924283 \"Hola desde WhatsApp_2\""
    echo ""
    echo "Nota: El número debe estar en formato internacional sin + ni espacios"
    exit 1
fi

echo -e "${YELLOW}Enviando mensaje...${NC}"
echo "Instancia: $INSTANCE_NAME"
echo "Destinatario: $NUMERO"
echo "Mensaje: $MENSAJE"
echo ""

# Enviar mensaje
RESPONSE=$(curl -s -X POST "$API_URL/message/sendText/$INSTANCE_NAME" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "{
    \"number\": \"$NUMERO\",
    \"text\": \"$MENSAJE\"
  }")

# Verificar respuesta
if echo "$RESPONSE" | grep -q "error"; then
    echo -e "${RED}❌ Error al enviar el mensaje${NC}"
    echo "$RESPONSE"
    exit 1
else
    echo -e "${GREEN}✅ Mensaje enviado correctamente${NC}"
    echo "$RESPONSE"
    exit 0
fi
