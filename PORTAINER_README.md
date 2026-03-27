# 🚀 Quick Start - Deploy en Portainer

## 1️⃣ Crear Personal Access Token en GitHub
```
https://github.com/settings/tokens
→ Generate new token (classic)
→ Permisos: read:packages, write:packages
→ Copiar token: ghp_xxxxxxxxxxxxxx
```

## 2️⃣ Configurar Registry en Portainer
```
http://10.128.200.16:9000
→ Registries → Add registry
→ URL: ghcr.io
→ User: jepeloa
→ Password: [tu PAT]
```

## 3️⃣ Deploy Stack
```
→ Stacks → Add stack
→ Name: evolution-api
→ Pegar docker-compose.portainer.yaml
→ Variables de entorno (copiar de .env.portainer):
   POSTGRES_DATABASE=evolution
   POSTGRES_USERNAME=postgres
   POSTGRES_PASSWORD=evolution_secure_password_2024
   AUTHENTICATION_API_KEY=429683C4C977415CAAFCCE10F7D57E11
   OPENAI_API_KEY=sk-proj-...
   DELIVERY_SMTP_USER=javier.epeloa@mapplics.com
   DELIVERY_SMTP_PASS=xxxx
   DELIVERY_EMAIL_FROM=javier.epeloa@mapplics.com
   DELIVERY_EMAIL_TO=javier.epeloa@mapplics.com
→ Deploy
```

## 4️⃣ Configurar Webhook para auto-redeploy
```
→ Stack evolution-api → Webhooks → Add webhook
→ Copiar URL del webhook
→ GitHub repo settings → Secrets → New secret
   Name: PORTAINER_WEBHOOK_URL
   Value: [URL copiada]
```

## ✅ Verificar
```bash
curl http://10.128.200.16:8081/
```

Ver guía completa: [PORTAINER_SETUP.md](./PORTAINER_SETUP.md)
