#!/bin/bash

# Script para configurar y crear un bot EvoAI en Evolution API
# EvoAI es un agente de IA que responde mensajes automáticamente

API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     🤖 Configuración de EvoAI Bot     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Verificar argumentos
if [ $# -lt 2 ]; then
    echo -e "${RED}Error: Faltan argumentos${NC}"
    echo ""
    echo "Uso: $0 INSTANCIA AGENT_URL [API_KEY]"
    echo ""
    echo "Ejemplos:"
    echo "  $0 Javier https://tu-agente-evoai.com/chat miApiKey123"
    echo "  $0 WhatsApp_2 https://api.evoai.com/agent/abc123"
    echo ""
    echo -e "${YELLOW}📝 Nota: Necesitas tener un agente EvoAI desplegado${NC}"
    exit 1
fi

INSTANCE_NAME=$1
AGENT_URL=$2
EVOAI_API_KEY=${3:-""}

echo -e "${YELLOW}📋 Configuración:${NC}"
echo "   Instancia: $INSTANCE_NAME"
echo "   Agent URL: $AGENT_URL"
echo "   API Key: ${EVOAI_API_KEY:-"(sin API key)"}"
echo ""

# Crear configuración del bot
read -p "Descripción del bot (opcional): " DESCRIPTION
DESCRIPTION=${DESCRIPTION:-"Bot EvoAI para atención automatizada"}

echo ""
echo -e "${YELLOW}🔧 Tipo de activación:${NC}"
echo "  1. all - Responde a todos los mensajes"
echo "  2. keyword - Solo cuando mencionan una palabra clave"
echo "  3. none - Desactivado"
echo "  4. advanced - Reglas avanzadas"
read -p "Selecciona (1-4) [1]: " TRIGGER_OPTION
TRIGGER_OPTION=${TRIGGER_OPTION:-1}

case $TRIGGER_OPTION in
    1) TRIGGER_TYPE="all" ;;
    2) TRIGGER_TYPE="keyword" 
       read -p "Palabra clave: " TRIGGER_VALUE
       TRIGGER_OPERATOR="contains"
       ;;
    3) TRIGGER_TYPE="none" ;;
    4) TRIGGER_TYPE="advanced"
       read -p "Valor del trigger: " TRIGGER_VALUE
       echo "Operadores: equals, contains, startsWith, endsWith, regex"
       read -p "Operador [contains]: " TRIGGER_OPERATOR
       TRIGGER_OPERATOR=${TRIGGER_OPERATOR:-"contains"}
       ;;
    *) TRIGGER_TYPE="all" ;;
esac

# Configuraciones adicionales
read -p "Delay entre mensajes (ms) [1000]: " DELAY_MESSAGE
DELAY_MESSAGE=${DELAY_MESSAGE:-1000}

read -p "Tiempo de expiración de sesión (minutos) [20]: " EXPIRE_MINUTES
EXPIRE_MINUTES=${EXPIRE_MINUTES:-20}
EXPIRE=$((EXPIRE_MINUTES * 60))

read -p "Palabra para finalizar conversación [#sair]: " KEYWORD_FINISH
KEYWORD_FINISH=${KEYWORD_FINISH:-"#sair"}

read -p "Mensaje cuando no entiende [No entiendo]: " UNKNOWN_MESSAGE
UNKNOWN_MESSAGE=${UNKNOWN_MESSAGE:-"Lo siento, no entiendo tu mensaje."}

# Crear payload JSON
JSON_PAYLOAD=$(cat <<EOF
{
  "enabled": true,
  "description": "$DESCRIPTION",
  "agentUrl": "$AGENT_URL",
  "apiKey": "$EVOAI_API_KEY",
  "triggerType": "$TRIGGER_TYPE",
  ${TRIGGER_VALUE:+"triggerValue": "$TRIGGER_VALUE",}
  ${TRIGGER_OPERATOR:+"triggerOperator": "$TRIGGER_OPERATOR",}
  "expire": $EXPIRE,
  "keywordFinish": "$KEYWORD_FINISH",
  "delayMessage": $DELAY_MESSAGE,
  "unknownMessage": "$UNKNOWN_MESSAGE",
  "listeningFromMe": false,
  "stopBotFromMe": true,
  "keepOpen": false,
  "debounceTime": 0,
  "ignoreJids": [],
  "splitMessages": true,
  "timePerChar": 100
}
EOF
)

echo ""
echo -e "${YELLOW}📤 Creando bot EvoAI...${NC}"

# Crear bot
RESPONSE=$(curl -s -X POST "$API_URL/evoai/create/$INSTANCE_NAME" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "$JSON_PAYLOAD")

if echo "$RESPONSE" | grep -q "error\|Error"; then
    echo -e "${RED}❌ Error al crear el bot${NC}"
    echo "$RESPONSE"
    exit 1
else
    echo -e "${GREEN}✅ Bot EvoAI creado correctamente${NC}"
    echo ""
    echo -e "${BLUE}📊 Detalles:${NC}"
    echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f'   ID: {data.get(\"id\", \"N/A\")}')
    print(f'   Descripción: {data.get(\"description\", \"N/A\")}')
    print(f'   Activación: {data.get(\"triggerType\", \"N/A\")}')
    print(f'   Estado: {\"Habilitado\" if data.get(\"enabled\") else \"Deshabilitado\"}')
except:
    print(sys.stdin.read())
" 2>/dev/null || echo "$RESPONSE"
    
    echo ""
    echo -e "${GREEN}🎉 ¡Bot configurado! Ahora responderá automáticamente${NC}"
fi
