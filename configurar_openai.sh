#!/bin/bash

# Script para configurar OpenAI en Evolution API
# Mucho más simple que EvoAI y funciona perfecto

API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🤖 Configuración de OpenAI Bot    ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

if [ $# -lt 2 ]; then
    echo -e "${RED}Error: Faltan argumentos${NC}"
    echo ""
    echo "Uso: $0 INSTANCIA OPENAI_API_KEY"
    echo ""
    echo "Ejemplo:"
    echo "  $0 Javier sk-proj-xxxxxxxxxxxxx"
    echo ""
    echo -e "${YELLOW}📝 Obtén tu API key en: https://platform.openai.com/api-keys${NC}"
    exit 1
fi

INSTANCE_NAME=$1
OPENAI_KEY=$2

echo -e "${YELLOW}📋 Configuración:${NC}"
echo "   Instancia: $INSTANCE_NAME"
echo "   OpenAI Key: ${OPENAI_KEY:0:20}..."
echo ""

read -p "Descripción del bot [Bot de IA]: " DESCRIPTION
DESCRIPTION=${DESCRIPTION:-"Bot de IA con OpenAI"}

echo ""
echo -e "${YELLOW}🔧 Tipo de activación:${NC}"
echo "  1. all - Responde a todos los mensajes"
echo "  2. keyword - Solo con palabra clave"
read -p "Selecciona (1-2) [1]: " TRIGGER_OPTION
TRIGGER_OPTION=${TRIGGER_OPTION:-1}

case $TRIGGER_OPTION in
    1) TRIGGER_TYPE="all" ;;
    2) TRIGGER_TYPE="keyword" 
       read -p "Palabra clave: " TRIGGER_VALUE
       TRIGGER_OPERATOR="contains"
       ;;
    *) TRIGGER_TYPE="all" ;;
esac

echo ""
read -p "Modelo GPT [gpt-4o-mini]: " MODEL
MODEL=${MODEL:-"gpt-4o-mini"}

read -p "Temperatura (0.0-2.0) [0.7]: " TEMPERATURE
TEMPERATURE=${TEMPERATURE:-0.7}

read -p "Máximo de tokens [1000]: " MAX_TOKENS
MAX_TOKENS=${MAX_TOKENS:-1000}

# Crear payload
JSON_PAYLOAD=$(cat <<EOF
{
  "enabled": true,
  "description": "$DESCRIPTION",
  "apiKey": "$OPENAI_KEY",
  "triggerType": "$TRIGGER_TYPE",
  ${TRIGGER_VALUE:+"triggerValue": "$TRIGGER_VALUE",}
  ${TRIGGER_OPERATOR:+"triggerOperator": "$TRIGGER_OPERATOR",}
  "expire": 1200,
  "keywordFinish": "#fin",
  "delayMessage": 1000,
  "unknownMessage": "Lo siento, no pude procesar tu mensaje.",
  "listeningFromMe": false,
  "stopBotFromMe": true,
  "keepOpen": false,
  "debounceTime": 0,
  "openaiCredsId": null,
  "model": "$MODEL",
  "systemMessages": ["Eres un asistente virtual útil y amigable. Responde de forma concisa y clara."],
  "assistantMessages": [],
  "userMessages": [],
  "maxTokens": $MAX_TOKENS,
  "temperature": $TEMPERATURE,
  "topP": 1,
  "n": 1,
  "stop": [],
  "presencePenalty": 0,
  "frequencyPenalty": 0
}
EOF
)

echo ""
echo -e "${YELLOW}📤 Creando bot OpenAI...${NC}"

RESPONSE=$(curl -s -X POST "$API_URL/openai/create/$INSTANCE_NAME" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "$JSON_PAYLOAD")

if echo "$RESPONSE" | grep -q "error\|Error"; then
    echo -e "${RED}❌ Error al crear el bot${NC}"
    echo "$RESPONSE"
    exit 1
else
    echo -e "${GREEN}✅ Bot OpenAI creado correctamente${NC}"
    echo ""
    echo -e "${GREEN}🎉 ¡Tu bot está listo!${NC}"
    echo "   Modelo: $MODEL"
    echo "   Activación: $TRIGGER_TYPE"
    echo ""
    echo -e "${YELLOW}💬 Pruébalo:${NC}"
    echo "   - Otros contactos pueden escribirte"
    echo "   - El bot responderá automáticamente"
    echo "   - Escribe '#fin' para terminar la conversación"
fi
