# 🔓 Hacer el Repositorio Público - Guía de Seguridad

## ✅ Cambios ya realizados

Todos los archivos sensibles ya están protegidos:

### 🔒 **Archivos protegidos (en .gitignore)**:
- ✅ `*.env` - Archivos de ambiente con credenciales
- ✅ `.env.portainer` - Credenciales de deployment
- ✅ `docker-compose.portainer.yaml` - Compose con variables sensibles
- ✅ `/instances/*` - Datos de WhatsApp

### 🧹 **API Keys removidas**:
- ✅ Todos los scripts `.sh` ahora usan `${EVOLUTION_API_KEY:-CHANGE_ME}`
- ✅ No hay credenciales hardcodeadas en el código fuente

## 🚀 Pasos para hacer el repositorio público

### 1️⃣ Verificar que no haya credenciales commiteadas

```bash
# Buscar en el historial
git log --all --full-history --source -S "429683C4C977415CAAFCCE10F7D57E11"
git log --all --full-history --source -S "evolution_secure_password"
git log --all --full-history --source -S "ghp_"
git log --all --full-history --source -S "sk-proj-"
```

Si encontrás algo, necesitarás limpiar el historial (ver sección de Troubleshooting).

### 2️⃣ Hacer un último commit limpio

```bash
cd /home/jav/whats-app-api

# Ver cambios
git status

# Agregar archivos limpios
git add *.sh .gitignore

# Commit
git commit -m "security: remove hardcoded API keys from scripts"

# Push
git push origin main
```

### 3️⃣ Hacer el repositorio público

1. Ve a: https://github.com/jepeloa/whats-app-api/settings
2. Scroll hasta "Danger Zone"
3. Click en **"Change visibility"**
4. Selecciona **"Make public"**
5. Confirma escribiendo el nombre del repositorio

### 4️⃣ La imagen Docker será pública automáticamente

Una vez que el repo sea público, GitHub Container Registry hará pública la imagen también:
- ✅ `ghcr.io/jepeloa/whats-app-api:latest` será accesible sin autenticación
- ✅ Portainer podrá hacer pull sin configurar registry credentials

### 5️⃣ Simplificar el workflow de GitHub Actions

Después de hacer público el repo, podés simplificar `.github/workflows/deploy-internal.yml`:

```yaml
- name: Notificar a Portainer (redeploy)
  run: |
    curl -X POST "${{ secrets.PORTAINER_WEBHOOK_URL }}"
```

El workflow seguirá funcionando igual, solo que ahora la imagen será pública.

## 🔐 Cómo usar el repositorio público de forma segura

### Para usuarios que clonen el repo:

1. **Clonar el repositorio**:
   ```bash
   git clone https://github.com/jepeloa/whats-app-api.git
   cd whats-app-api
   ```

2. **Copiar el archivo de ejemplo**:
   ```bash
   cp env.example .env
   ```

3. **Editar `.env` con tus credenciales**:
   ```bash
   nano .env
   # Cambiar valores:
   # - AUTHENTICATION_API_KEY
   # - DATABASE_CONNECTION_URI
   # - OPENAI_API_KEY (si usás OpenAI)
   ```

4. **Configurar scripts con tu API key**:
   ```bash
   export EVOLUTION_API_KEY="tu-api-key-aqui"
   
   # O editar cada script manualmente
   ```

5. **Ejecutar**:
   ```bash
   # Con Docker Compose
   docker-compose up -d
   ```

## 🛡️ Buenas prácticas

### ✅ HACER:
- Usar variables de entorno para credenciales
- Mantener archivos `.env` en `.gitignore`
- Rotar API keys periódicamente
- Usar diferentes credenciales para desarrollo y producción
- Documentar qué variables se necesitan en `env.example`

### ❌ NO HACER:
- Commitear archivos `.env` con credenciales reales
- Hardcodear API keys en el código
- Usar las mismas credenciales de producción en desarrollo
- Compartir credenciales en issues o pull requests

## 🔧 Troubleshooting

### Si encuentro credenciales en el historial de Git

Si encontrás credenciales commiteadas en el historial, hay dos opciones:

**Opción A: Reescribir el historial (PELIGROSO)**
```bash
# BFG Repo-Cleaner (recomendado)
brew install bfg # o descargar desde https://rtyley.github.io/bfg-repo-cleaner/
bfg --replace-text passwords.txt
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force
```

**Opción B: Rotar todas las credenciales expuestas**
1. Cambiar todas las API keys/passwords que aparecen en el historial
2. Actualizar en producción
3. Hacer público el repo (las credenciales viejas ya no servirán)

### La imagen Docker sigue siendo privada

Si después de hacer público el repo, la imagen sigue privada:

1. Ve a: https://github.com/jepeloa/whats-app-api/pkgs/container/whats-app-api/settings
2. En "Danger Zone" → "Change visibility" → "Public"

## ✅ Checklist final antes de hacer público

- [ ] No hay API keys hardcodeadas en `.sh` scripts
- [ ] Archivo `.env` está en `.gitignore`
- [ ] No hay `.env` en el historial de Git (solo `.env.example`)
- [ ] `docker-compose.portainer.yaml` está en `.gitignore`
- [ ] Variables sensibles usan `${VAR:-default}` pattern
- [ ] README documenta qué variables se necesitan
- [ ] El último commit limpia todas las credenciales

## 📚 Referencias

- [GitHub: Making a repository public](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [GitHub Container Registry: Visibility](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#about-the-container-registry)
- [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/)
