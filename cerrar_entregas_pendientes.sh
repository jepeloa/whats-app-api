#!/bin/bash

# =============================================================================
# CERRAR ENTREGAS PENDIENTES - Evolution API Delivery Tracking
# =============================================================================
# 
# Este script marca todas las entregas pendientes como completadas.
# Útil para limpiar entregas de prueba o cancelar entregas activas.
#
# USO: ./cerrar_entregas_pendientes.sh
# =============================================================================

SERVER_IP="167.71.214.252"
DB_USER="postgres"
DB_NAME="evolution"

echo "🔄 Cerrando todas las entregas pendientes..."

ssh -l root ${SERVER_IP} "docker exec evolution_postgres psql -U ${DB_USER} -d ${DB_NAME} -c \"UPDATE \\\"DeliveryTracking\\\" SET status = 'completed' WHERE status != 'completed';\""

echo ""
echo "✅ Entregas pendientes cerradas."
