# 🔑 Configuración de Variables de Entorno

Este repositorio usa variables de entorno para proteger información sensible.

## Variables requeridas para scripts .sh

Todos los scripts de utilidad (`.sh`) usan la variable de entorno `EVOLUTION_API_KEY`:

```bash
# Opción 1: Exportar en tu sesión actual
export EVOLUTION_API_KEY="tu-api-key-aqui"

# Opción 2: Agregar a tu .bashrc o .zshrc
echo 'export EVOLUTION_API_KEY="tu-api-key-aqui"' >> ~/.bashrc
source ~/.bashrc

# Opción 3: Prefijo al ejecutar el script
EVOLUTION_API_KEY="tu-api-key-aqui" ./crear_instancia.sh MiInstancia
```

## Scripts que usan esta variable

- `crear_instancia.sh`
- `listar_instancias.sh`
- `configurar_webhook.sh`
- `leer_mensajes.sh`
- `enviar_mensaje.sh`
- `configurar_openai.sh`
- `configurar_evoai.sh`
- `crear_entrega_ejemplo.sh`
- `crear_entrega_heraldo.sh`
- `cerrar_entregas_pendientes.sh`

## Variables para Docker Compose (Producción)

Para deployment en producción, necesitás estas variables:

```bash
# Database
POSTGRES_DATABASE=evolution
POSTGRES_USERNAME=postgres
POSTGRES_PASSWORD=tu-password-seguro

# API Authentication
AUTHENTICATION_API_KEY=tu-api-key-aqui

# OpenAI (opcional)
OPENAI_API_KEY=sk-proj-...

# Email for Delivery Tracking (opcional)
DELIVERY_SMTP_USER=tu-email@example.com
DELIVERY_SMTP_PASS=tu-password-smtp
DELIVERY_EMAIL_FROM=tu-email@example.com
DELIVERY_EMAIL_TO=destinatario@example.com
```

Ver `env.example` para la lista completa de variables disponibles.

## Obtener tu API Key

La API key se genera automáticamente al iniciar la aplicación por primera vez, o podés configurarla en el archivo `.env`:

```bash
# En .env
AUTHENTICATION_API_KEY=tu-api-key-personalizada
```

Podés generar una API key segura con:

```bash
openssl rand -hex 16
```

## Seguridad

⚠️ **NUNCA** commitees archivos con credenciales reales:
- ✅ Usar `env.example` con valores de ejemplo
- ✅ Mantener `.env` en `.gitignore`
- ✅ Usar variables de entorno en scripts
- ❌ NO hardcodear API keys en el código
