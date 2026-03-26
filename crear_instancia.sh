#!/bin/bash

# Script para crear una nueva instancia de WhatsApp
# Uso: ./crear_instancia.sh NOMBRE_INSTANCIA

API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ $# -lt 1 ]; then
    echo -e "${RED}Error: Falta el nombre de la instancia${NC}"
    echo ""
    echo "Uso: $0 NOMBRE_INSTANCIA"
    echo ""
    echo "Ejemplos:"
    echo "  $0 WhatsApp_Ventas"
    echo "  $0 Soporte_Cliente"
    echo "  $0 Marketing"
    exit 1
fi

INSTANCE_NAME=$1

echo -e "${YELLOW}Creando instancia: $INSTANCE_NAME${NC}"
echo ""

# Crear instancia
RESPONSE=$(curl -s -X POST "$API_URL/instance/create" \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d "{
    \"instanceName\": \"$INSTANCE_NAME\",
    \"integration\": \"WHATSAPP-BAILEYS\"
  }")

if echo "$RESPONSE" | grep -q "error"; then
    echo -e "${RED}❌ Error al crear la instancia${NC}"
    echo "$RESPONSE"
    exit 1
fi

echo -e "${GREEN}✅ Instancia creada correctamente${NC}"
echo ""
echo -e "${YELLOW}Obteniendo QR Code...${NC}"
sleep 2

# Obtener QR
QR_RESPONSE=$(curl -s "$API_URL/instance/connect/$INSTANCE_NAME" \
  -H "apikey: $API_KEY")

# Extraer el código QR
QR_CODE=$(echo "$QR_RESPONSE" | grep -o '"code":"[^"]*"' | cut -d'"' -f4)

if [ -n "$QR_CODE" ]; then
    echo ""
    echo -e "${GREEN}QR Code generado:${NC}"
    echo "$QR_CODE"
    echo ""
    
    # Si tienes qrencode instalado, mostrar el QR en terminal
    if command -v qrencode &> /dev/null; then
        echo "$QR_CODE" | qrencode -t UTF8
    else
        echo -e "${YELLOW}💡 Instala 'qrencode' para ver el QR en la terminal:${NC}"
        echo "   sudo apt install qrencode"
    fi
    
    echo ""
    echo -e "${GREEN}📱 Escanea el QR con WhatsApp:${NC}"
    echo "   1. Abre WhatsApp en tu teléfono"
    echo "   2. Ve a ⋮ (menú) → Dispositivos vinculados"
    echo "   3. Toca 'Vincular un dispositivo'"
    echo "   4. Escanea el QR"
    echo ""
    echo -e "${YELLOW}O accede al Manager Web:${NC}"
    echo "   http://localhost:8081/manager/"
else
    echo -e "${RED}No se pudo obtener el QR Code${NC}"
    echo "$QR_RESPONSE"
fi
