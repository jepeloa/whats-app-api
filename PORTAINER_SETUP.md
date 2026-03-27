# Setup de Portainer con GHCR (GitHub Container Registry)

## 🔐 Paso 1: Crear Personal Access Token (PAT) en GitHub

1. Ve a: https://github.com/settings/tokens
2. Click en **"Generate new token"** → **"Generate new token (classic)"**
3. Configuración del token:
   - **Note**: `Portainer GHCR Access`
   - **Expiration**: `No expiration` (o el tiempo que prefieras)
   - **Permisos necesarios**:
     - ✅ `read:packages` (Descargar paquetes de GitHub Container Registry)
     - ✅ `write:packages` (Si querés subir imágenes también)
4. Click **"Generate token"**
5. **⚠️ IMPORTANTE**: Copiá el token AHORA (solo se muestra una vez)
   - Formato: `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## 📝 Paso 2: Configurar credenciales locales

Editá el archivo `.env.portainer` y reemplazá:
```bash
GHCR_TOKEN=ghp_YOUR_GITHUB_PERSONAL_ACCESS_TOKEN_HERE
```

Con tu token real.

## 🐳 Paso 3: Configurar Registry en Portainer

### Opción A: Via Portainer UI (Recomendado)

1. Accedé a Portainer: http://10.128.200.16:9000
2. Ve a **Registries** en el menú lateral
3. Click **"Add registry"**
4. Configuración:
   - **Name**: `GitHub Container Registry`
   - **Registry URL**: `ghcr.io`
   - **Authentication**: Activado
   - **Username**: `jepeloa`
   - **Password**: Tu Personal Access Token (ghp_...)
5. Click **"Add registry"**

### Opción B: Via CLI (Alternativa)

En el servidor donde corre Portainer:
```bash
docker login ghcr.io -u jepeloa -p ghp_YOUR_TOKEN_HERE
```

## 🚀 Paso 4: Deploy del Stack en Portainer

1. En Portainer, ve a **Stacks**
2. Click **"Add stack"**
3. Configuración:
   - **Name**: `evolution-api`
   - **Build method**: **"Web editor"**
   - Pegá el contenido de `docker-compose.portainer.yaml`
4. En **"Environment variables"**, agregá:
   ```
   GHCR_USERNAME=jepeloa
   GHCR_TOKEN=ghp_YOUR_TOKEN_HERE
   POSTGRES_DATABASE=evolution
   POSTGRES_USERNAME=postgres
   POSTGRES_PASSWORD=evolution_secure_password_2024
   AUTHENTICATION_API_KEY=429683C4C977415CAAFCCE10F7D57E11
   OPENAI_API_KEY=sk-proj-...
   DELIVERY_SMTP_USER=javier.epeloa@mapplics.com
   DELIVERY_SMTP_PASS=xxxx
   DELIVERY_EMAIL_FROM=javier.epeloa@mapplics.com
   DELIVERY_EMAIL_TO=javier.epeloa@mapplics.com
   ```
5. Click **"Deploy the stack"**

## 🔄 Paso 5: Configurar Auto-redeploy con Webhook

1. En Portainer, ve al stack **evolution-api**
2. En la pestaña del stack, buscá **"Webhooks"**
3. Click **"Add a webhook"**
4. Configuración:
   - **Webhook type**: `Restart stack`
   - Copiá la **Webhook URL** generada
5. Agregá el webhook como secret en GitHub:
   - Ve a: https://github.com/jepeloa/whats-app-api/settings/secrets/actions
   - Click **"New repository secret"**
   - **Name**: `PORTAINER_WEBHOOK_URL`
   - **Value**: La URL del webhook copiada
   - Click **"Add secret"**

## ✅ Verificación

Después del deploy:
```bash
# Ver logs de la API
curl http://10.128.200.16:8081/

# Verificar containers
docker ps | grep evolution
```

## 🔧 Troubleshooting

### Error: "unauthorized: authentication required"
- Verificá que el registry esté configurado correctamente en Portainer
- Verificá que el token tenga permisos `read:packages`
- Intentá hacer `docker login ghcr.io` manualmente en el servidor

### Error: "manifest unknown"
- La imagen aún no se construyó en GitHub Actions
- Verificá: https://github.com/jepeloa/whats-app-api/actions
- Esperá a que el build termine exitosamente

### La imagen no se actualiza automáticamente
- Verificá que el webhook esté configurado correctamente
- Verificá que el secret `PORTAINER_WEBHOOK_URL` esté en GitHub
- Revisá los logs de GitHub Actions para ver si el webhook se llamó
