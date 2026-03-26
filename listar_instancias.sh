#!/bin/bash

# Script para listar todas las instancias de WhatsApp

API_URL="http://localhost:8081"
API_KEY="${EVOLUTION_API_KEY:-CHANGE_ME}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Instancias de WhatsApp ===${NC}"
echo ""

RESPONSE=$(curl -s "$API_URL/instance/fetchInstances" \
  -H "apikey: $API_KEY")

if echo "$RESPONSE" | grep -q "error"; then
    echo -e "${RED}❌ Error al obtener las instancias${NC}"
    echo "$RESPONSE"
    exit 1
fi

# Parsear y mostrar de forma legible
echo "$RESPONSE" | python3 -c "
import sys, json

try:
    instances = json.load(sys.stdin)
    
    if not instances:
        print('⚠️  No hay instancias creadas')
        sys.exit(0)
    
    print(f'Total de instancias: {len(instances)}\n')
    
    for idx, inst in enumerate(instances, 1):
        status = inst.get('connectionStatus', 'unknown')
        status_emoji = '✅' if status == 'open' else '❌' if status == 'close' else '⚠️'
        
        print(f'{idx}. {status_emoji} {inst.get(\"name\", \"Sin nombre\")}')
        print(f'   Estado: {status}')
        print(f'   Número: {inst.get(\"number\", \"N/A\")}')
        print(f'   Tipo: {inst.get(\"integration\", \"N/A\")}')
        print(f'   Creada: {inst.get(\"createdAt\", \"N/A\")[:10]}')
        print()
        
except Exception as e:
    print('Error al parsear JSON:', str(e))
    print(sys.stdin.read())
" 2>/dev/null || {
    # Si no hay Python3, mostrar JSON crudo
    echo "$RESPONSE"
}
