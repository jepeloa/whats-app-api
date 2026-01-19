#!/usr/bin/env python3
"""
Servidor Webhook para recibir mensajes de WhatsApp en tiempo real.

Este script crea un servidor HTTP que escucha los eventos de Evolution API.
Cuando llega un mensaje nuevo, lo muestra en la consola.

Uso:
    1. Ejecutar: python3 webhook_receiver.py
    2. Configurar el webhook en Evolution API apuntando a http://localhost:5000/webhook
    
Requisitos:
    pip install flask
"""

from flask import Flask, request, jsonify
from datetime import datetime
import json

app = Flask(__name__)

# Colores para terminal
class Colors:
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    END = '\033[0m'

def format_timestamp(timestamp):
    """Convierte timestamp a formato legible"""
    try:
        if isinstance(timestamp, (int, float)):
            return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M:%S')
        return str(timestamp)
    except:
        return str(timestamp)

def extract_message_text(message):
    """Extrae el texto del mensaje de diferentes tipos"""
    if not message:
        return "[Sin contenido]"
    
    # Mensaje de texto simple
    if 'conversation' in message:
        return message['conversation']
    
    # Mensaje extendido con texto
    if 'extendedTextMessage' in message:
        return message['extendedTextMessage'].get('text', '[Texto extendido]')
    
    # Imagen con caption
    if 'imageMessage' in message:
        caption = message['imageMessage'].get('caption', '')
        return f"📷 [Imagen] {caption}" if caption else "📷 [Imagen]"
    
    # Video con caption
    if 'videoMessage' in message:
        caption = message['videoMessage'].get('caption', '')
        return f"🎥 [Video] {caption}" if caption else "🎥 [Video]"
    
    # Audio
    if 'audioMessage' in message:
        return "🎵 [Audio]"
    
    # Documento
    if 'documentMessage' in message:
        filename = message['documentMessage'].get('fileName', 'documento')
        return f"📄 [Documento: {filename}]"
    
    # Sticker
    if 'stickerMessage' in message:
        return "🎨 [Sticker]"
    
    # Ubicación
    if 'locationMessage' in message:
        return "📍 [Ubicación]"
    
    # Contacto
    if 'contactMessage' in message:
        return "👤 [Contacto]"
    
    # Reacción
    if 'reactionMessage' in message:
        emoji = message['reactionMessage'].get('text', '👍')
        return f"💫 [Reacción: {emoji}]"
    
    return f"[Tipo de mensaje no reconocido: {list(message.keys())}]"

@app.route('/webhook', methods=['POST'])
def webhook():
    """Endpoint que recibe los eventos de Evolution API"""
    try:
        data = request.json
        
        if not data:
            return jsonify({'status': 'no data'}), 200
        
        event = data.get('event', 'unknown')
        instance = data.get('instance', 'unknown')
        
        # Procesar según el tipo de evento
        if event == 'messages.upsert':
            process_message_upsert(data, instance)
        elif event == 'messages.update':
            process_message_update(data, instance)
        elif event == 'connection.update':
            process_connection_update(data, instance)
        elif event == 'qrcode.updated':
            print(f"\n{Colors.YELLOW}📱 QR Code actualizado para instancia: {instance}{Colors.END}")
        else:
            print(f"\n{Colors.CYAN}📌 Evento: {event} | Instancia: {instance}{Colors.END}")
        
        return jsonify({'status': 'received'}), 200
    
    except Exception as e:
        print(f"{Colors.RED}Error procesando webhook: {e}{Colors.END}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

def process_message_upsert(data, instance):
    """Procesa mensajes nuevos"""
    messages = data.get('data', [])
    
    if isinstance(messages, dict):
        messages = [messages]
    
    for msg in messages:
        key = msg.get('key', {})
        remote_jid = key.get('remoteJid', 'Desconocido')
        from_me = key.get('fromMe', False)
        push_name = msg.get('pushName', 'Desconocido')
        timestamp = msg.get('messageTimestamp', '')
        message = msg.get('message', {})
        
        # Extraer texto del mensaje
        text = extract_message_text(message)
        
        # Formatear número (quitar @s.whatsapp.net)
        phone = remote_jid.replace('@s.whatsapp.net', '').replace('@g.us', ' [Grupo]')
        
        # Determinar dirección del mensaje
        if from_me:
            direction = f"{Colors.BLUE}📤 ENVIADO{Colors.END}"
            sender = "Yo"
        else:
            direction = f"{Colors.GREEN}📥 RECIBIDO{Colors.END}"
            sender = push_name or phone
        
        # Imprimir mensaje formateado
        print(f"\n{'='*60}")
        print(f"{direction}")
        print(f"📱 Instancia: {Colors.CYAN}{instance}{Colors.END}")
        print(f"👤 {Colors.BOLD}De: {sender}{Colors.END} ({phone})")
        print(f"⏰ Hora: {format_timestamp(timestamp)}")
        print(f"💬 Mensaje: {Colors.YELLOW}{text}{Colors.END}")
        print(f"{'='*60}")

def process_message_update(data, instance):
    """Procesa actualizaciones de mensajes (leído, entregado, etc.)"""
    updates = data.get('data', [])
    
    if isinstance(updates, dict):
        updates = [updates]
    
    for update in updates:
        key = update.get('key', {})
        status = update.get('update', {}).get('status')
        
        status_map = {
            0: '⏳ Pendiente',
            1: '✓ Enviado',
            2: '✓✓ Entregado',
            3: '✓✓ Leído',
            4: '🎵 Reproducido'
        }
        
        status_text = status_map.get(status, f'Estado: {status}')
        phone = key.get('remoteJid', '').replace('@s.whatsapp.net', '')
        
        print(f"\n📊 Estado actualizado → {status_text} | {phone}")

def process_connection_update(data, instance):
    """Procesa actualizaciones de conexión"""
    connection_data = data.get('data', {})
    state = connection_data.get('state', 'unknown')
    
    state_icons = {
        'open': f'{Colors.GREEN}🟢 Conectado{Colors.END}',
        'close': f'{Colors.RED}🔴 Desconectado{Colors.END}',
        'connecting': f'{Colors.YELLOW}🟡 Conectando...{Colors.END}'
    }
    
    status = state_icons.get(state, f'Estado: {state}')
    print(f"\n🔗 Conexión | Instancia: {instance} | {status}")

@app.route('/health', methods=['GET'])
def health():
    """Endpoint de health check"""
    return jsonify({'status': 'ok', 'service': 'Evolution API Webhook Receiver'}), 200

@app.route('/', methods=['GET'])
def index():
    """Página principal"""
    return """
    <html>
        <head><title>Evolution API Webhook Receiver</title></head>
        <body style="font-family: Arial; padding: 20px; background: #1a1a2e; color: #eee;">
            <h1>🚀 Evolution API Webhook Receiver</h1>
            <p>Este servidor está escuchando eventos de WhatsApp.</p>
            <h3>Endpoints:</h3>
            <ul>
                <li><code>POST /webhook</code> - Recibe eventos de Evolution API</li>
                <li><code>GET /health</code> - Health check</li>
            </ul>
            <h3>Configuración:</h3>
            <p>Configura tu webhook en Evolution API apuntando a:</p>
            <code style="background: #333; padding: 10px; display: block;">http://TU_IP:5000/webhook</code>
        </body>
    </html>
    """

if __name__ == '__main__':
    print(f"""
{Colors.GREEN}{'='*60}
🚀 Evolution API Webhook Receiver
{'='*60}{Colors.END}

Servidor iniciado en: {Colors.CYAN}http://localhost:5000{Colors.END}
Webhook URL: {Colors.YELLOW}http://localhost:5000/webhook{Colors.END}

{Colors.BOLD}Para configurar el webhook en Evolution API:{Colors.END}
1. Ir al Manager: http://localhost:8081/manager/
2. Seleccionar tu instancia
3. Configurar Webhook URL: http://localhost:5000/webhook
4. Activar eventos: MESSAGES_UPSERT, CONNECTION_UPDATE

{Colors.GREEN}Esperando mensajes...{Colors.END}
""")
    
    app.run(host='0.0.0.0', port=5000, debug=False)
