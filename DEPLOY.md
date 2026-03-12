# Guía de Deploy - Evolution API con Delivery Tracking

## Servidor

- **IP**: 167.71.214.252
- **Puerto**: 8081
- **Branch**: `lasibila_tracking`
- **Directorio en servidor**: `/root/whats-app-api`

## Deploy seguro (sin perder conexión WhatsApp)

```bash
# 1. Conectarse al servidor
ssh root@167.71.214.252

# 2. Ir al directorio del proyecto
cd /root/whats-app-api

# 3. Traer los últimos cambios
git pull origin lasibila_tracking

# 4. Reconstruir SOLO el container de la API
docker compose up -d --build api
```

**Eso es todo.** La sesión de WhatsApp se mantiene porque:

- Las credenciales están en PostgreSQL (tabla `Session`), no en el container de la API
- PostgreSQL tiene su propio container (`evolution_postgres`) con volumen persistente `postgres_data`
- El comando `--build api` solo reconstruye la API, **nunca toca la base de datos**
- Al reiniciar, el monitor auto-reconecta usando las credenciales guardadas

## Qué NUNCA hacer

| Comando | Efecto |
|---------|--------|
| `DELETE /instance/logout/{name}` | **BORRA las credenciales** y desvincula el dispositivo en WhatsApp. Requiere escanear QR de nuevo. |
| `DELETE /instance/delete/{name}` | **ELIMINA la instancia completa** de la BD. Se pierde todo. |
| `docker compose down -v` | **BORRA los volúmenes** incluyendo la base de datos. Se pierde todo. |
| `docker volume rm postgres_data` | **BORRA la base de datos**. Se pierde todo. |

## Comandos seguros

| Comando | Efecto |
|---------|--------|
| `docker compose up -d --build api` | Reconstruye y reinicia solo la API. Sesión intacta. |
| `docker compose restart api` | Reinicia la API sin reconstruir. Sesión intacta. |
| `docker compose down` (sin `-v`) | Detiene todos los containers. Los volúmenes persisten. |
| `docker compose up -d` | Levanta todo de nuevo. Se auto-reconecta. |

## Reconectar una instancia (si se pierde la sesión)

Si por algún motivo se pierde la sesión, hay dos opciones:

### Opción 1: QR Code
```bash
curl -s -X GET "http://167.71.214.252:8081/instance/connect/POC-test-sibila" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"
```
Devuelve un QR en base64. Escanear desde WhatsApp → Dispositivos vinculados.

### Opción 2: Pairing Code (sin escanear QR)
```bash
# Primero verificar que el estado sea "close"
curl -s "http://167.71.214.252:8081/instance/connectionState/POC-test-sibila" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"

# Solicitar pairing code con el número del dueño
curl -s -X GET "http://167.71.214.252:8081/instance/connect/POC-test-sibila?number=5493412679125" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"

# Esperar 5 segundos y volver a llamar para obtener el código
sleep 5
curl -s -X GET "http://167.71.214.252:8081/instance/connect/POC-test-sibila?number=5493412679125" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"
```

Devuelve un código de 8 caracteres (ej: `GJDEQ14D`). Ingresar en WhatsApp → Dispositivos vinculados → Vincular dispositivo → Vincular con número de teléfono.

**Importante**: El pairing code expira en ~20 segundos. Generar uno nuevo si no se ingresa a tiempo.

## Verificar estado de la conexión

```bash
curl -s "http://167.71.214.252:8081/instance/connectionState/POC-test-sibila" \
  -H "apikey: 429683C4C977415CAAFCCE10F7D57E11"
```

Respuesta esperada cuando está conectada:
```json
{"instance": {"instanceName": "POC-test-sibila", "state": "open"}}
```

## Verificar logs después del deploy

```bash
ssh root@167.71.214.252 "docker logs evolution_api --tail 50"
```

Buscar estas líneas que confirman reconexión exitosa:
```
Auto-connecting instance "POC-test-sibila" (status: open)
```

## Instancia actual

| Campo | Valor |
|-------|-------|
| Nombre | `POC-test-sibila` |
| ID | `f2486f83-187d-45ba-9af2-349a883c4b11` |
| Token | `06860E3EBBAF-44BC-8352-6215B9BCB8A3` |
| Dueño | `5493412679125` (Santa Sylvina) |
| API Key | `429683C4C977415CAAFCCE10F7D57E11` |

## Por qué funciona la persistencia

```
┌─────────────────┐     ┌──────────────────────┐
│  Container API  │────▶│ Container PostgreSQL  │
│ (se reconstruye │     │  (NO se toca)         │
│  en cada deploy)│     │                       │
└─────────────────┘     │  Tabla Session:       │
                        │  - sessionId          │
                        │  - creds (JSON)       │
                        │                       │
                        │  Tabla Instance:       │
                        │  - connectionStatus   │
                        └──────────┬───────────┘
                                   │
                          ┌────────▼────────┐
                          │  Volumen Docker  │
                          │  postgres_data   │
                          │  (PERSISTENTE)   │
                          └─────────────────┘
```

1. `DATABASE_SAVE_DATA_INSTANCE=true` → credenciales se guardan en PostgreSQL
2. `postgres_data` es un volumen Docker → sobrevive rebuilds
3. Al iniciar, `monitor.service.ts` lee `connectionStatus` de la BD
4. Si es `open` o `connecting` → auto-reconecta con las credenciales guardadas
