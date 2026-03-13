import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { DeliveryStatus, DeliveryTracking } from '@prisma/client';
import { getConversationMessage } from '@utils/getConversationMessage';
import * as fs from 'fs';
import OpenAI from 'openai';

import { CreateDeliveryDto } from '../dto/delivery.dto';
import { DeliveryEmailService } from './delivery-email.service';
import { DeliveryPdfService } from './delivery-pdf.service';

/**
 * JSON Schema for OpenAI Structured Outputs
 * Guarantees valid JSON responses from the model
 */
const DELIVERY_RESPONSE_SCHEMA = {
  name: 'delivery_response',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Mensaje amigable y breve para el camionero (máximo 2 oraciones)',
      },
      actions: {
        type: 'array',
        description: 'Lista de acciones a ejecutar. Vacío si es solo conversación.',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'confirm_delivery',
                'update_delivery',
                'report_issue',
                'request_location',
                'chat',
                'query_pending',
              ],
              description:
                'confirm_delivery: confirmar entrega en ubicación. update_delivery: corregir kilos ya entregados. report_issue: reportar problema. request_location: pedir ubicación GPS. chat: conversación general. query_pending: consulta sobre pesadas pendientes.',
            },
            ubicacion: {
              type: ['string', 'null'],
              description: 'Nombre exacto de la ubicación (solo para confirm_delivery y update_delivery)',
            },
            kilos: {
              type: ['number', 'null'],
              description: 'Kilos descargados. -1 significa "el resto". Null si no aplica.',
            },
            observacion: {
              type: ['string', 'null'],
              description: 'Observación sobre problemas, incidentes o notas. Null si no hay.',
            },
          },
          required: ['action', 'ubicacion', 'kilos', 'observacion'],
          additionalProperties: false,
        },
      },
    },
    required: ['message', 'actions'],
    additionalProperties: false,
  },
} as const;

interface AIResponse {
  message: string;
  actions: Array<{
    action: 'confirm_delivery' | 'update_delivery' | 'report_issue' | 'request_location' | 'chat' | 'query_pending';
    ubicacion: string | null;
    kilos: number | null;
    observacion: string | null;
  }>;
}

export class DeliveryService {
  private readonly logger = new Logger('DeliveryService');
  private openaiClient: OpenAI;
  private readonly pdfService = new DeliveryPdfService();

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
    private readonly emailService: DeliveryEmailService,
  ) {
    this.initOpenAI();
  }

  private initOpenAI() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openaiClient = new OpenAI({ apiKey });
      this.logger.info('OpenAI client initialized for DeliveryService');
    } else {
      this.logger.warn('OPENAI_API_KEY not configured');
    }
  }

  /**
   * Formats a phone number to WhatsApp JID format
   */
  private formatToJid(phoneNumber: string): string {
    // Remove all non-numeric characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  /**
   * Get instance by name
   */
  private async getInstance(instanceName: string) {
    return this.prismaRepository.instance.findUnique({
      where: { name: instanceName },
    });
  }

  /**
   * Build the initial message for the truck driver
   */
  private buildInitialMessage(data: CreateDeliveryDto): string {
    const ubicacionesList = data.ubicaciones.map((u, i) => `${i + 1}. ${u.nombre} (${u.direccion})`).join('\n');

    return `Hola ${data.choferNombre}! Registramos en nuestro sistema el traslado con el camión dominio ${data.patente} del producto ${data.artNombre}, desde ${data.origen} a ${data.ubicaciones.length > 1 ? 'las siguientes ubicaciones' : data.ubicaciones[0]?.nombre} por ${data.pesoNeto} ${data.pesoUn}. ¿Podrás confirmarnos la descarga?

${data.ubicaciones.length > 1 ? `Ubicaciones de descarga:\n${ubicacionesList}` : ''}`;
  }

  /**
   * Build the system prompt for OpenAI to process driver responses
   * Supports structured outputs — no manual JSON parsing needed
   */
  private buildSystemPrompt(delivery: DeliveryTracking & { locations: any[] }): string {
    const pendingLocations = delivery.locations
      .filter((l) => l.status === 'pending')
      .map((l) => `- ${l.nombre}: ${l.direccion}`)
      .join('\n');

    const deliveredLocations = delivery.locations
      .filter((l) => l.status === 'delivered')
      .map((l) => `- ${l.nombre}: ${l.direccion} (${l.kilosDescargados?.toLocaleString('es-AR') || '?'} kg)`)
      .join('\n');

    // Calcular kilos ya descargados
    const kilosDescargados = delivery.locations
      .filter((l) => l.status === 'delivered' && l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);
    const kilosRestantes = delivery.pesoNeto - kilosDescargados;

    const firstName = delivery.choferNombre.split(' ')[0];

    // Check which delivered locations are missing GPS
    const deliveredWithoutGps = delivery.locations
      .filter((l) => l.status === 'delivered' && l.latitude == null)
      .map((l) => l.nombre);

    const gpsNote =
      deliveredWithoutGps.length > 0
        ? `\nUBICACIONES SIN GPS: ${deliveredWithoutGps.join(', ')}. Después de confirmar entrega, pedí la ubicación GPS al camionero.`
        : '';

    return `Eres un asistente de logística para el camionero ${firstName}. Tu trabajo principal es gestionar la pesada #${delivery.idPesada}, pero también podés responder preguntas generales.

PESO TOTAL A ENTREGAR: ${delivery.pesoNeto.toLocaleString('es-AR')} ${delivery.pesoUn}
KILOS YA DESCARGADOS: ${kilosDescargados.toLocaleString('es-AR')} kg
KILOS RESTANTES: ${kilosRestantes.toLocaleString('es-AR')} kg

UBICACIONES PENDIENTES:
${pendingLocations || 'Ninguna'}

UBICACIONES ENTREGADAS:
${deliveredLocations || 'Ninguna'}
${gpsNote}

REGLAS CRÍTICAS:
1. Respondé MUY BREVE (máximo 2 oraciones).
2. FLUJO OBLIGATORIO para cada ubicación: primero confirmar kilos descargados con "confirm_delivery", luego SIEMPRE pedir GPS con "request_location". NO hay excepciones.
3. Si el camionero menciona kilos Y un problema (pérdida, accidente, rotura, etc.), usá "confirm_delivery" con los kilos que SÍ descargó + la observación del problema. Ejemplo: "perdí la mitad, descargue 500" → confirm_delivery con kilos:500 y observacion:"Pérdida parcial de carga".
4. Solo usá "report_issue" SIN ubicación cuando el problema es GENERAL (no asociado a una ubicación específica). Ejemplo: "tuve un accidente en la ruta".
5. Si el camionero NO pudo descargar NADA en una ubicación (cerrada, no estaba el dueño, etc.), usá "confirm_delivery" con kilos:0 y la observación. Ejemplo: "estaba cerrado" → confirm_delivery con kilos:0, observacion:"Local cerrado".
6. Si dice "el resto", "lo que queda", "todo", usa kilos: -1 (el sistema calcula ${kilosRestantes.toLocaleString('es-AR')} kg).
7. Valida que los kilos no excedan ${kilosRestantes.toLocaleString('es-AR')} kg restantes.
8. Después de confirm_delivery, SIEMPRE agrega request_location. En el mensaje pedí la ubicación de forma simple: "📍 ¿Podés compartirme tu ubicación?".
9. Si el camionero confirma varias ubicaciones en un mensaje, genera un action por cada una, cada uno seguido de request_location.
10. Si dice "toneladas", multiplicá por 1000.
11. Detecta "me equivoqué", "en realidad eran", "corrijo" → "update_delivery".
12. Si el camionero responde solo con un NÚMERO (ej: "5000") después de que preguntaste los kilos, SIEMPRE genera confirm_delivery para la ubicación que estás preguntando. NUNCA devuelvas actions vacío.
13. Si el camionero dice "2" o un número de ubicación sin kilos, preguntale cuántos kilos descargó ahí.

CHAT GENERAL:
- Preguntas no relacionadas con la entrega → action "chat".
- "cuántas pesadas tengo" → action "query_pending".
- "a dónde me queda ir" → respondé con pendientes, action "chat".

ACCIONES DISPONIBLES:
- "confirm_delivery": confirmar entrega en ubicación (requiere ubicacion, kilos, observacion opcional). TAMBIÉN usar para ubicaciones donde no se descargó nada (kilos:0 + observacion).
- "update_delivery": corregir kilos ya entregados (requiere ubicacion, kilos)
- "report_issue": problema general NO asociado a ubicación específica (requiere observacion, ubicacion debe ser null)
- "request_location": pedir GPS al camionero. SIEMPRE va después de confirm_delivery.
- "chat": conversación general
- "query_pending": consultar pesadas pendientes

EJEMPLOS:

Camionero: "1 3000kg"
→ message: "¡Perfecto ${firstName}! Confirmados 3.000 kg en [ubicación 1]. 📍 ¿Podés compartirme tu ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 1]","kilos":3000,"observacion":null}, {"action":"request_location","ubicacion":"[nombre ubicación 1]","kilos":null,"observacion":null}]

Camionero: "2 perdí la mitad, descargue 500"
→ message: "Registré la descarga de 500 kg y el incidente en [ubicación 2]. 📍 ¿Podés compartirme tu ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 2]","kilos":500,"observacion":"Pérdida parcial de carga"}, {"action":"request_location","ubicacion":"[nombre ubicación 2]","kilos":null,"observacion":null}]

Camionero: "en 2 no descargue, estaba cerrado"
→ message: "Entendido ${firstName}, registré que estaba cerrado."
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 2]","kilos":0,"observacion":"Local cerrado"}]

Camionero: "Entregué el resto en la terminal"
→ message: "¡Perfecto ${firstName}! Confirmados los ${kilosRestantes.toLocaleString('es-AR')} kg restantes. 📍 ¿Podés compartirme tu ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"Terminal Puerto","kilos":-1,"observacion":null}, {"action":"request_location","ubicacion":"Terminal Puerto","kilos":null,"observacion":null}]

Camionero: "Tuve un accidente en la ruta"
→ message: "Lamento escuchar eso ${firstName}. ¿Pudiste entregar algo? Registré el incidente."
→ actions: [{"action":"report_issue","ubicacion":null,"kilos":null,"observacion":"Accidente en la ruta"}]

(Contexto: acabas de preguntar "cuántos kilos descargaste en Terminal Sur?")
Camionero: "5000"
→ message: "¡Perfecto ${firstName}! Confirmados 5.000 kg en Terminal Sur. 📍 ¿Podés compartirme tu ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"Terminal Sur","kilos":5000,"observacion":null}, {"action":"request_location","ubicacion":"Terminal Sur","kilos":null,"observacion":null}]

IMPORTANTE:
- TODA descarga (con o sin problema) se registra con confirm_delivery.
- report_issue es SOLO para problemas generales sin ubicación.
- SIEMPRE pedí ubicación GPS después de confirmar kilos > 0.
- Para correcciones de ubicaciones YA ENTREGADAS usá "update_delivery".`;
  }

  /**
   * Create a new delivery tracking
   */
  async create(instanceName: string, data: CreateDeliveryDto) {
    this.logger.info(`Creating delivery for pesada ${data.idPesada} in instance ${instanceName}`);

    const instance = await this.getInstance(instanceName);
    if (!instance) {
      throw new Error(`Instance ${instanceName} not found`);
    }

    const remoteJid = this.formatToJid(data.phoneNumber);

    // Check if there's already an active delivery for this phone number
    // Active = pending or in_progress (partial/completed/not_delivered means closed)
    const existingActive = await this.prismaRepository.deliveryTracking.findFirst({
      where: {
        remoteJid,
        instanceId: instance.id,
        status: { in: ['pending', 'in_progress'] },
      },
    });

    if (existingActive) {
      throw new Error(
        `El camionero ${data.phoneNumber} ya tiene un pedido activo (Pesada #${existingActive.idPesada}). Debe cerrarse antes de crear uno nuevo.`,
      );
    }

    // Check if this idPesada already exists for this instance
    const existingPesada = await this.prismaRepository.deliveryTracking.findUnique({
      where: {
        idPesada_instanceId: {
          idPesada: data.idPesada,
          instanceId: instance.id,
        },
      },
    });

    if (existingPesada) {
      throw new Error(`La pesada #${data.idPesada} ya existe en esta instancia`);
    }

    // Create delivery tracking with locations
    const delivery = await this.prismaRepository.deliveryTracking.create({
      data: {
        idPesada: data.idPesada,
        remoteJid,
        choferNombre: data.choferNombre,
        patente: data.patente,
        artNombre: data.artNombre,
        origen: data.origen,
        pesoNeto: data.pesoNeto,
        pesoUn: data.pesoUn,
        status: 'pending',
        emailRecipients: data.emailRecipients?.join(',') || process.env.DELIVERY_EMAIL_TO || '',
        metadata: data.metadata || {},
        instanceId: instance.id,
        locations: {
          create: data.ubicaciones.map((u, index) => ({
            nombre: u.nombre,
            direccion: u.direccion,
            orden: u.orden ?? index + 1,
            status: 'pending',
          })),
        },
      },
      include: {
        locations: true,
      },
    });

    // Log initial system message for audit
    await this.logMessage(delivery.id, 'system', `Pesada creada. Enviando mensaje inicial al camionero.`);

    // Send initial message to the driver
    const initialMessage = this.buildInitialMessage(data);
    await this.sendWhatsAppMessage(instanceName, remoteJid, initialMessage);

    // Log the sent message
    await this.logMessage(delivery.id, 'assistant', initialMessage);

    this.logger.info(`Delivery ${delivery.id} created successfully for pesada ${data.idPesada}`);

    return {
      delivery: {
        id: delivery.id,
        idPesada: delivery.idPesada,
        remoteJid: delivery.remoteJid,
        choferNombre: delivery.choferNombre,
        status: delivery.status,
        locations: delivery.locations.map((l) => ({
          id: l.id,
          nombre: l.nombre,
          direccion: l.direccion,
          status: l.status,
        })),
        createdAt: delivery.createdAt,
      },
    };
  }

  /**
   * Send a WhatsApp message using the instance
   */
  private async sendWhatsAppMessage(instanceName: string, remoteJid: string, message: string) {
    const waInstance = this.waMonitor.waInstances[instanceName];
    if (!waInstance) {
      this.logger.error(`WhatsApp instance ${instanceName} not found`);
      throw new Error(`WhatsApp instance ${instanceName} not found`);
    }

    try {
      await waInstance.textMessage(
        {
          number: remoteJid.replace('@s.whatsapp.net', ''),
          text: message,
        },
        false,
      );
      this.logger.info(`Message sent to ${remoteJid}`);
    } catch (error) {
      this.logger.error(`Error sending message: ${error.message}`);
      throw error;
    }
  }

  /**
   * Send a document (PDF) via WhatsApp
   */
  private async sendWhatsAppDocument(
    instanceName: string,
    remoteJid: string,
    filePath: string,
    fileName: string,
    caption?: string,
  ) {
    const waInstance = this.waMonitor.waInstances[instanceName];
    if (!waInstance) {
      this.logger.error(`WhatsApp instance ${instanceName} not found`);
      throw new Error(`WhatsApp instance ${instanceName} not found`);
    }

    try {
      // Read file and convert to base64
      const fileBuffer = fs.readFileSync(filePath);
      const base64 = fileBuffer.toString('base64');

      await waInstance.mediaMessage(
        {
          number: remoteJid.replace('@s.whatsapp.net', ''),
          mediatype: 'document',
          mimetype: 'application/pdf',
          media: base64,
          fileName: fileName,
          caption: caption,
        },
        undefined,
        false,
      );
      this.logger.info(`Document ${fileName} sent to ${remoteJid}`);
    } catch (error) {
      this.logger.error(`Error sending document: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log a message for audit with optional type and action data
   */
  private async logMessage(
    deliveryTrackingId: string,
    role: string,
    content: string,
    messageType: string = 'text',
    actionData?: any,
  ) {
    await this.prismaRepository.deliveryMessage.create({
      data: {
        deliveryTrackingId,
        role,
        content,
        messageType,
        actionData: actionData || undefined,
      },
    });
  }

  /**
   * Extract location data from a WhatsApp message if present
   */
  private extractLocationFromMessage(messageRaw: any): { latitude: number; longitude: number } | null {
    const locationMsg = messageRaw?.message?.locationMessage;
    if (locationMsg && locationMsg.degreesLatitude && locationMsg.degreesLongitude) {
      return {
        latitude: locationMsg.degreesLatitude,
        longitude: locationMsg.degreesLongitude,
      };
    }
    const liveLocationMsg = messageRaw?.message?.liveLocationMessage;
    if (liveLocationMsg && liveLocationMsg.degreesLatitude && liveLocationMsg.degreesLongitude) {
      return {
        latitude: liveLocationMsg.degreesLatitude,
        longitude: liveLocationMsg.degreesLongitude,
      };
    }
    return null;
  }

  /**
   * Process an incoming message from a driver
   */
  async processIncomingMessage(instanceName: string, remoteJid: string, messageRaw: any) {
    const instance = await this.getInstance(instanceName);
    if (!instance) {
      return;
    }

    // Find active delivery for this phone number
    const delivery = await this.prismaRepository.deliveryTracking.findFirst({
      where: {
        remoteJid,
        instanceId: instance.id,
        status: { in: ['pending', 'in_progress'] },
      },
      include: {
        locations: {
          orderBy: { orden: 'asc' },
        },
      },
    });

    if (!delivery) {
      // No active delivery — respond as general chat or show pending deliveries
      await this.handleNoActiveDelivery(remoteJid, instance.id, instanceName, messageRaw);
      return;
    }

    // Check if this is a location message (GPS)
    const locationData = this.extractLocationFromMessage(messageRaw);
    if (locationData) {
      await this.handleLocationMessage(delivery, locationData, instanceName);
      return;
    }

    // Extract message content
    const content = getConversationMessage(messageRaw);
    if (!content) {
      return;
    }

    this.logger.info(`Processing message from ${remoteJid} for pesada ${delivery.idPesada}: ${content}`);

    // Update status to in_progress if still pending
    if (delivery.status === 'pending') {
      await this.prismaRepository.deliveryTracking.update({
        where: { id: delivery.id },
        data: { status: 'in_progress', lastMessageAt: new Date() },
      });
    } else {
      await this.prismaRepository.deliveryTracking.update({
        where: { id: delivery.id },
        data: { lastMessageAt: new Date() },
      });
    }

    // Detect message type for audit
    const msgType = this.detectMessageType(messageRaw);

    // Log incoming message for audit
    await this.logMessage(delivery.id, 'user', content, msgType);

    // Get conversation history for context
    const messages = await this.prismaRepository.deliveryMessage.findMany({
      where: { deliveryTrackingId: delivery.id },
      orderBy: { timestamp: 'asc' },
      take: 20,
    });

    // Build messages for OpenAI
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.buildSystemPrompt(delivery) },
      ...messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
    ];

    // Get AI response with structured outputs
    const aiResponse = await this.getAIResponse(openaiMessages);
    if (!aiResponse) {
      return;
    }

    this.logger.verbose(`AI structured response for pesada ${delivery.idPesada}: ${JSON.stringify(aiResponse)}`);

    // Log AI response for audit, including actions
    const actionsForAudit = aiResponse.actions.length > 0 ? aiResponse.actions : undefined;
    await this.logMessage(delivery.id, 'assistant', aiResponse.message, 'text', actionsForAudit);

    // Process actions
    for (const action of aiResponse.actions) {
      if (action.action === 'chat' || action.action === 'request_location') {
        // No DB action needed — message already includes the text
        continue;
      }

      if (action.action === 'query_pending') {
        // Append pending deliveries info to the AI message (sent below)
        const pendingInfo = await this.buildPendingDeliveriesInfo(remoteJid, instance.id);
        if (pendingInfo) {
          aiResponse.message = aiResponse.message ? `${aiResponse.message}\n\n${pendingInfo}` : pendingInfo;
        }
        continue;
      }

      await this.processSingleAction(delivery, action, instanceName);
    }

    // Send message to driver
    if (aiResponse.message) {
      await this.sendWhatsAppMessage(instanceName, remoteJid, aiResponse.message);
    }
  }

  /**
   * Detect message type from raw WhatsApp message
   */
  private detectMessageType(messageRaw: any): string {
    if (messageRaw?.message?.locationMessage || messageRaw?.message?.liveLocationMessage) return 'location';
    if (messageRaw?.message?.audioMessage || messageRaw?.message?.speechToText) return 'audio';
    if (messageRaw?.message?.imageMessage) return 'image';
    if (messageRaw?.message?.documentMessage) return 'document';
    return 'text';
  }

  /**
   * Handle a GPS location message from the driver
   * Associates it with the most recent delivered location that lacks GPS
   */
  private async handleLocationMessage(
    delivery: DeliveryTracking & { locations: any[] },
    locationData: { latitude: number; longitude: number },
    instanceName: string,
  ) {
    // Find the most recently delivered location without GPS
    const locationWithoutGps = delivery.locations
      .filter((l: any) => l.status === 'delivered' && l.latitude == null)
      .sort((a: any, b: any) => {
        // Most recently delivered first
        const aTime = a.deliveredAt ? new Date(a.deliveredAt).getTime() : 0;
        const bTime = b.deliveredAt ? new Date(b.deliveredAt).getTime() : 0;
        return bTime - aTime;
      })[0];

    if (locationWithoutGps) {
      await this.prismaRepository.deliveryLocation.update({
        where: { id: locationWithoutGps.id },
        data: {
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          gpsTimestamp: new Date(),
        },
      });

      await this.logMessage(
        delivery.id,
        'system',
        `GPS recibido para "${locationWithoutGps.nombre}": ${locationData.latitude}, ${locationData.longitude}`,
        'location',
        locationData,
      );

      const thankMsg = `📍 ¡Perfecto! Registré tu ubicación para ${locationWithoutGps.nombre}. Gracias!`;
      await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, thankMsg);
      await this.logMessage(delivery.id, 'assistant', thankMsg);

      this.logger.info(
        `GPS saved for location ${locationWithoutGps.nombre}: ${locationData.latitude}, ${locationData.longitude}`,
      );

      // After saving GPS, re-check if all locations are now complete
      // (this handles the case where we were waiting for GPS before closing)
      await this.checkDeliveryComplete(delivery.id, instanceName);
    } else {
      // All locations already have GPS, or none delivered yet
      const infoMsg = '📍 Recibí tu ubicación. ¡Gracias!';
      await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, infoMsg);
      await this.logMessage(delivery.id, 'assistant', infoMsg, 'location', locationData);
    }
  }

  /**
   * Handle messages when the driver has no active delivery
   * Acts as a general chat assistant and can show pending deliveries
   */
  private async handleNoActiveDelivery(remoteJid: string, instanceId: string, instanceName: string, messageRaw: any) {
    const content = getConversationMessage(messageRaw);
    if (!content) return;

    this.logger.info(`No active delivery for ${remoteJid}, handling as general chat: ${content}`);

    // Check if they're asking about pending deliveries
    const pendingInfo = await this.buildPendingDeliveriesInfo(remoteJid, instanceId);

    // Build a simple chat response using OpenAI
    const systemPrompt = `Eres un asistente de logística amigable. El camionero no tiene una pesada activa asignada en este momento.
Respondé de forma breve y útil. Si pregunta sobre pesadas, órdenes o entregas pendientes, la información está abajo.

${pendingInfo || 'No tiene pesadas pendientes.'}

Si pregunta algo general (clima, direcciones, etc.), respondé normalmente.
Si pregunta sobre entregas, usá la info de arriba.
Respondé siempre en español, breve y amigable.`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ];

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages,
        max_tokens: 500,
        temperature: 0.7,
      });

      const reply = response.choices[0]?.message?.content;
      if (reply) {
        await this.sendWhatsAppMessage(instanceName, remoteJid, reply);
      }
    } catch (error) {
      this.logger.error(`OpenAI error in general chat: ${error.message}`);
    }
  }

  /**
   * Build info about pending deliveries for this driver
   */
  private async buildPendingDeliveriesInfo(remoteJid: string, instanceId: string): Promise<string | null> {
    const pendingDeliveries = await this.prismaRepository.deliveryTracking.findMany({
      where: {
        remoteJid,
        instanceId,
        status: { in: ['pending', 'in_progress'] },
      },
      include: { locations: { orderBy: { orden: 'asc' } } },
    });

    if (pendingDeliveries.length === 0) {
      return '✅ No tenés pesadas pendientes en este momento.';
    }

    let info = `📋 *Tus pesadas activas:*\n`;
    for (const d of pendingDeliveries) {
      const pending = d.locations.filter((l) => l.status === 'pending').length;
      const delivered = d.locations.filter((l) => l.status === 'delivered').length;
      info += `\n• *${d.idPesada}* - ${d.artNombre}\n  ${delivered}/${d.locations.length} ubicaciones entregadas, ${pending} pendientes\n`;
      const pendingLocs = d.locations.filter((l) => l.status === 'pending');
      for (const loc of pendingLocs) {
        info += `  → ${loc.nombre} (${loc.direccion})\n`;
      }
    }
    return info;
  }

  /**
   * Get AI response using OpenAI with Structured Outputs
   */
  private async getAIResponse(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<AIResponse | null> {
    if (!this.openaiClient) {
      this.logger.error('OpenAI client not initialized');
      return null;
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o',
        messages,
        max_tokens: 1000,
        temperature: 0.3,
        response_format: {
          type: 'json_schema',
          json_schema: DELIVERY_RESPONSE_SCHEMA,
        },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return null;

      const parsed: AIResponse = JSON.parse(content);
      return parsed;
    } catch (error) {
      this.logger.error(`OpenAI API error: ${error.message}`);
      return null;
    }
  }

  /**
   * Process a single action from AI structured response
   */
  private async processSingleAction(
    delivery: DeliveryTracking & { locations: any[] },
    action: AIResponse['actions'][0],
    instanceName: string,
  ) {
    try {
      // IMPORTANT: Reload delivery from DB to get current real values
      const freshDelivery = await this.prismaRepository.deliveryTracking.findUnique({
        where: { id: delivery.id },
        include: { locations: { orderBy: { orden: 'asc' } } },
      });

      if (!freshDelivery) {
        this.logger.error(`Delivery ${delivery.id} not found when processing action`);
        return;
      }

      // Calculate real kilos from DB
      const kilosYaDescargados = freshDelivery.locations
        .filter((l) => l.status === 'delivered' && l.kilosDescargados)
        .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);
      const kilosRestantes = freshDelivery.pesoNeto - kilosYaDescargados;

      // Handle issue reports (general problems not tied to a specific location)
      if (action.action === 'report_issue' && action.observacion) {
        await this.addObservacion(freshDelivery.id, action.observacion);
        this.logger.info(`Issue reported for pesada ${freshDelivery.idPesada}: ${action.observacion}`);
        return;
      }

      // Handle delivery update (correction)
      if (action.action === 'update_delivery' && action.ubicacion) {
        const location = freshDelivery.locations.find(
          (l) =>
            (l.nombre.toLowerCase().includes(action.ubicacion!.toLowerCase()) ||
              action.ubicacion!.toLowerCase().includes(l.nombre.toLowerCase())) &&
            l.status === 'delivered',
        );

        if (location) {
          const oldKilos = location.kilosDescargados || 0;
          let newKilos = action.kilos;

          if (action.kilos === -1) {
            const otrosKilos = freshDelivery.locations
              .filter((l) => l.status === 'delivered' && l.kilosDescargados && l.id !== location.id)
              .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);
            newKilos = freshDelivery.pesoNeto - otrosKilos;
          }

          await this.prismaRepository.deliveryLocation.update({
            where: { id: location.id },
            data: {
              kilosDescargados: newKilos,
              notes: action.observacion || location.notes,
            },
          });

          this.logger.info(
            `Location ${location.nombre} updated for pesada ${freshDelivery.idPesada}: ${oldKilos} kg -> ${newKilos} kg`,
          );

          await this.logMessage(
            freshDelivery.id,
            'system',
            `Corrección en "${location.nombre}": ${oldKilos.toLocaleString('es-AR')} kg → ${(newKilos || 0).toLocaleString('es-AR')} kg`,
            'action',
            { action: 'update_delivery', ubicacion: location.nombre, oldKilos, newKilos },
          );

          if (action.observacion) {
            await this.addObservacion(freshDelivery.id, `${location.nombre} (corrección): ${action.observacion}`);
          }
        }
        return;
      }

      // Handle delivery confirmation
      if (action.action === 'confirm_delivery' && action.ubicacion) {
        let kilosToDeliver = action.kilos;

        if (action.kilos === -1) {
          kilosToDeliver = kilosRestantes;
          this.logger.info(`Auto-calculating "resto": ${kilosRestantes} kg for pesada ${freshDelivery.idPesada}`);
        }

        if (kilosToDeliver !== null && kilosToDeliver !== undefined && kilosToDeliver > kilosRestantes) {
          this.logger.warn(
            `Kilos exceden el límite: ${kilosToDeliver} > ${kilosRestantes} restantes para pesada ${freshDelivery.idPesada}`,
          );
        }

        const location = freshDelivery.locations.find(
          (l) =>
            (l.nombre.toLowerCase().includes(action.ubicacion!.toLowerCase()) ||
              action.ubicacion!.toLowerCase().includes(l.nombre.toLowerCase())) &&
            l.status === 'pending',
        );

        if (location) {
          await this.prismaRepository.deliveryLocation.update({
            where: { id: location.id },
            data: {
              status: 'delivered',
              deliveredAt: new Date(),
              kilosDescargados: kilosToDeliver || null,
              notes: action.observacion || null,
            },
          });

          this.logger.info(
            `Location ${location.nombre} marked as delivered for pesada ${freshDelivery.idPesada} with ${kilosToDeliver || '?'} kg`,
          );

          const kilosText = kilosToDeliver ? ` (${kilosToDeliver.toLocaleString('es-AR')} kg)` : '';
          await this.logMessage(
            freshDelivery.id,
            'system',
            `Ubicación "${location.nombre}" marcada como entregada${kilosText}.`,
            'action',
            { action: 'confirm_delivery', ubicacion: location.nombre, kilos: kilosToDeliver },
          );

          if (action.observacion) {
            await this.addObservacion(freshDelivery.id, `${location.nombre}: ${action.observacion}`);
          }

          await this.checkDeliveryComplete(freshDelivery.id, instanceName);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing action: ${error.message}`);
    }
  }

  /**
   * Add observation to delivery tracking
   */
  private async addObservacion(deliveryId: string, observacion: string) {
    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) return;

    const timestamp = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const newObs = `[${timestamp}] ${observacion}`;
    const currentObs = delivery.observaciones || '';
    const updatedObs = currentObs ? `${currentObs}\n${newObs}` : newObs;

    await this.prismaRepository.deliveryTracking.update({
      where: { id: deliveryId },
      data: { observaciones: updatedObs },
    });

    await this.logMessage(deliveryId, 'system', `Observación registrada: ${observacion}`);
  }

  /**
   * Check if all locations are delivered and update delivery status
   */
  private async checkDeliveryComplete(deliveryId: string, instanceName: string) {
    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: { orderBy: { orden: 'asc' } }, messages: true },
    });

    if (!delivery) return;

    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');

    if (pendingLocations.length === 0) {
      // All locations delivered — check if we're still waiting for GPS on any location
      const locationsWithoutGps = delivery.locations.filter(
        (l) => l.status === 'delivered' && l.latitude == null && l.kilosDescargados && l.kilosDescargados > 0,
      );

      if (locationsWithoutGps.length > 0) {
        // Don't complete yet — wait for GPS. The AI message already asked for GPS,
        // so we just silently wait without sending another message.
        this.logger.info(
          `Delivery ${delivery.idPesada}: all locations delivered but ${locationsWithoutGps.length} missing GPS. Waiting.`,
        );
        return;
      }

      // All locations delivered and GPS collected (or not applicable) - mark as completed
      const confirmedAt = new Date();
      await this.prismaRepository.deliveryTracking.update({
        where: { id: deliveryId },
        data: {
          status: 'completed',
          confirmedAt,
        },
      });

      this.logger.info(`Delivery ${delivery.idPesada} completed! All locations delivered.`);

      // Log completion
      await this.logMessage(deliveryId, 'system', 'Todas las ubicaciones fueron entregadas. Pesada completada.');

      // Send WhatsApp summary
      const summaryMessage = this.buildCompletionSummary(delivery, confirmedAt);
      await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, summaryMessage);
      await this.logMessage(deliveryId, 'assistant', summaryMessage);

      // Generate and send PDF report
      try {
        const pdfData = {
          idPesada: delivery.idPesada,
          choferNombre: delivery.choferNombre,
          patente: delivery.patente,
          artNombre: delivery.artNombre,
          origen: delivery.origen,
          pesoNeto: delivery.pesoNeto,
          pesoUn: delivery.pesoUn,
          status: 'completed',
          observaciones: delivery.observaciones,
          createdAt: delivery.createdAt,
          confirmedAt: confirmedAt,
          locations: delivery.locations.map((loc) => ({
            nombre: loc.nombre,
            direccion: loc.direccion,
            kilosDescargados: loc.kilosDescargados,
            notes: loc.notes,
            status: loc.status,
            deliveredAt: loc.deliveredAt,
            orden: loc.orden,
            latitude: loc.latitude,
            longitude: loc.longitude,
          })),
        };

        const pdfPath = await this.pdfService.generateDeliveryReport(pdfData);
        const pdfFileName = `Reporte_Pesada_${delivery.idPesada}.pdf`;

        await this.sendWhatsAppDocument(
          instanceName,
          delivery.remoteJid,
          pdfPath,
          pdfFileName,
          `📄 Reporte de entrega - Pesada ${delivery.idPesada}`,
        );
        await this.logMessage(deliveryId, 'system', `PDF de reporte enviado: ${pdfFileName}`);

        // Cleanup temp file
        await this.pdfService.cleanupPdf(pdfPath);
      } catch (pdfError) {
        this.logger.error(`Error generating/sending PDF: ${pdfError.message}`);
        // Don't fail the whole process if PDF fails
      }

      // Send completion email
      await this.emailService.sendDeliveryCompletedEmail(delivery, 'completed');
    }
  }

  /**
   * Build completion summary message with times and details
   */
  private buildCompletionSummary(
    delivery: {
      idPesada: string;
      choferNombre: string;
      patente: string;
      artNombre: string;
      origen: string;
      pesoNeto: number;
      pesoUn: string;
      createdAt: Date;
      observaciones?: string | null;
      locations: Array<{
        nombre: string;
        direccion: string;
        deliveredAt: Date | null;
        kilosDescargados?: number | null;
        notes?: string | null;
        orden: number;
      }>;
    },
    confirmedAt: Date,
  ): string {
    const startTime = new Date(delivery.createdAt);
    const totalMinutes = Math.round((confirmedAt.getTime() - startTime.getTime()) / (1000 * 60));
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    // Calculate total kilos delivered
    const totalKilosDescargados = delivery.locations
      .filter((l) => l.deliveredAt && l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);

    let summary = `📋 *RESUMEN DE ENTREGA COMPLETADA*\n\n`;
    summary += `✅ *Pesada:* ${delivery.idPesada}\n`;
    summary += `🚚 *Chofer:* ${delivery.choferNombre}\n`;
    summary += `🔢 *Patente:* ${delivery.patente}\n`;
    summary += `📦 *Producto:* ${delivery.artNombre}\n`;
    summary += `📍 *Origen:* ${delivery.origen}\n`;
    summary += `⚖️ *Peso cargado:* ${delivery.pesoNeto.toLocaleString('es-AR')} ${delivery.pesoUn}\n`;
    summary += `⚖️ *Total descargado:* ${totalKilosDescargados.toLocaleString('es-AR')} kg\n\n`;

    summary += `📍 *DESCARGAS POR UBICACIÓN:*\n`;

    delivery.locations
      .filter((l) => l.deliveredAt)
      .sort((a, b) => a.orden - b.orden)
      .forEach((location, index) => {
        const deliveredAt = new Date(location.deliveredAt!);
        const minutesFromStart = Math.round((deliveredAt.getTime() - startTime.getTime()) / (1000 * 60));
        const hoursFromStart = Math.floor(minutesFromStart / 60);
        const minsFromStart = minutesFromStart % 60;

        const timeStr = hoursFromStart > 0 ? `${hoursFromStart}h ${minsFromStart}min` : `${minsFromStart} min`;
        const kilosStr = location.kilosDescargados
          ? `${location.kilosDescargados.toLocaleString('es-AR')} kg`
          : 'Sin especificar';

        summary += `${index + 1}. ${location.nombre}\n`;
        summary += `   ⚖️ Descarga: ${kilosStr}\n`;
        summary += `   ⏱️ Tiempo: ${timeStr}\n`;
        if (location.notes) {
          summary += `   📝 Nota: ${location.notes}\n`;
        }
      });

    // Check for discrepancy
    const diferencia = delivery.pesoNeto - totalKilosDescargados;
    if (diferencia !== 0) {
      summary += `\n⚠️ *DIFERENCIA:* ${diferencia.toLocaleString('es-AR')} kg `;
      summary += diferencia > 0 ? '(faltante)\n' : '(excedente)\n';
    }

    summary += `\n⏱️ *TIEMPO TOTAL DE VIAJE:* `;
    if (totalHours > 0) {
      summary += `${totalHours} hora${totalHours > 1 ? 's' : ''} ${remainingMinutes} minutos\n`;
    } else {
      summary += `${remainingMinutes} minutos\n`;
    }

    summary += `\n🕐 *Inicio:* ${startTime.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}\n`;
    summary += `🕐 *Fin:* ${confirmedAt.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}\n`;

    // Add observations if any
    if (delivery.observaciones) {
      summary += `\n📝 *OBSERVACIONES:*\n${delivery.observaciones}\n`;
    }

    summary += `\n¡Gracias por tu trabajo, ${delivery.choferNombre.split(' ')[0]}! 🙌`;

    return summary;
  }

  /**
   * Get delivery status by idPesada
   */
  async getStatus(instanceName: string, idPesada: string) {
    const instance = await this.getInstance(instanceName);
    if (!instance) {
      throw new Error(`Instance ${instanceName} not found`);
    }

    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: {
        idPesada_instanceId: {
          idPesada,
          instanceId: instance.id,
        },
      },
      include: {
        locations: { orderBy: { orden: 'asc' } },
      },
    });

    if (!delivery) {
      throw new Error(`Pesada ${idPesada} not found`);
    }

    // Calculate total kilos delivered
    const totalKilosDescargados = delivery.locations
      .filter((l) => l.status === 'delivered' && l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);

    return {
      delivery: {
        id: delivery.id,
        idPesada: delivery.idPesada,
        remoteJid: delivery.remoteJid,
        choferNombre: delivery.choferNombre,
        patente: delivery.patente,
        artNombre: delivery.artNombre,
        origen: delivery.origen,
        pesoNeto: delivery.pesoNeto,
        pesoUn: delivery.pesoUn,
        totalKilosDescargados,
        diferencia: delivery.pesoNeto - totalKilosDescargados,
        status: delivery.status,
        observaciones: delivery.observaciones,
        reminderCount: delivery.reminderCount,
        locations: delivery.locations.map((l) => ({
          id: l.id,
          nombre: l.nombre,
          direccion: l.direccion,
          status: l.status,
          kilosDescargados: l.kilosDescargados,
          notes: l.notes,
          deliveredAt: l.deliveredAt,
          latitude: l.latitude,
          longitude: l.longitude,
        })),
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
        confirmedAt: delivery.confirmedAt,
      },
    };
  }

  /**
   * List deliveries for an instance
   */
  async list(instanceName: string, status?: string, limit = 20, offset = 0) {
    const instance = await this.getInstance(instanceName);
    if (!instance) {
      throw new Error(`Instance ${instanceName} not found`);
    }

    const where: any = { instanceId: instance.id };
    if (status) {
      where.status = status;
    }

    const [deliveries, total] = await Promise.all([
      this.prismaRepository.deliveryTracking.findMany({
        where,
        include: { locations: { orderBy: { orden: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prismaRepository.deliveryTracking.count({ where }),
    ]);

    return {
      deliveries: deliveries.map((d) => ({
        id: d.id,
        idPesada: d.idPesada,
        choferNombre: d.choferNombre,
        status: d.status,
        locationsDelivered: d.locations.filter((l) => l.status === 'delivered').length,
        locationsTotal: d.locations.length,
        createdAt: d.createdAt,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Close a delivery manually
   */
  async close(instanceName: string, idPesada: string, reason?: string) {
    const instance = await this.getInstance(instanceName);
    if (!instance) {
      throw new Error(`Instance ${instanceName} not found`);
    }

    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: {
        idPesada_instanceId: {
          idPesada,
          instanceId: instance.id,
        },
      },
      include: { locations: true, messages: true },
    });

    if (!delivery) {
      throw new Error(`Pesada ${idPesada} not found`);
    }

    if (delivery.status === 'completed' || delivery.status === 'not_delivered') {
      throw new Error(`Pesada ${idPesada} is already closed with status: ${delivery.status}`);
    }

    const deliveredLocations = delivery.locations.filter((l) => l.status === 'delivered');
    let newStatus: DeliveryStatus;

    if (deliveredLocations.length === 0) {
      newStatus = 'not_delivered';
    } else if (deliveredLocations.length < delivery.locations.length) {
      newStatus = 'partial';
    } else {
      newStatus = 'completed';
    }

    await this.prismaRepository.deliveryTracking.update({
      where: { id: delivery.id },
      data: {
        status: newStatus,
        confirmedAt: new Date(),
      },
    });

    // Log closure
    await this.logMessage(
      delivery.id,
      'system',
      `Pesada cerrada manualmente. Razón: ${reason || 'No especificada'}. Estado final: ${newStatus}`,
    );

    // Send email
    await this.emailService.sendDeliveryCompletedEmail({ ...delivery, status: newStatus }, newStatus);

    this.logger.info(`Delivery ${idPesada} closed manually with status ${newStatus}`);

    return {
      delivery: {
        idPesada,
        status: newStatus,
        closedAt: new Date(),
        reason,
      },
    };
  }

  /**
   * Get audit trail for a delivery
   */
  async getAudit(instanceName: string, idPesada: string) {
    const instance = await this.getInstance(instanceName);
    if (!instance) {
      throw new Error(`Instance ${instanceName} not found`);
    }

    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: {
        idPesada_instanceId: {
          idPesada,
          instanceId: instance.id,
        },
      },
      include: {
        locations: { orderBy: { orden: 'asc' } },
        messages: { orderBy: { timestamp: 'asc' } },
      },
    });

    if (!delivery) {
      throw new Error(`Pesada ${idPesada} not found`);
    }

    return {
      delivery: {
        idPesada: delivery.idPesada,
        choferNombre: delivery.choferNombre,
        patente: delivery.patente,
        status: delivery.status,
        createdAt: delivery.createdAt,
        confirmedAt: delivery.confirmedAt,
      },
      locations: delivery.locations.map((l) => ({
        nombre: l.nombre,
        direccion: l.direccion,
        status: l.status,
        deliveredAt: l.deliveredAt,
        latitude: l.latitude,
        longitude: l.longitude,
      })),
      conversation: delivery.messages.map((m) => ({
        role: m.role,
        content: m.content,
        messageType: m.messageType,
        actionData: m.actionData,
        timestamp: m.timestamp,
      })),
    };
  }

  /**
   * Send a reminder to the driver
   */
  async sendReminder(deliveryId: string, instanceName: string) {
    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: true },
    });

    if (!delivery || delivery.status === 'completed' || delivery.status === 'not_delivered') {
      return;
    }

    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');
    const maxReminders = parseInt(process.env.DELIVERY_MAX_REMINDERS || '3', 10);

    if (delivery.reminderCount >= maxReminders) {
      // Max reminders reached, close the delivery
      const deliveredLocations = delivery.locations.filter((l) => l.status === 'delivered');
      let newStatus: DeliveryStatus;

      if (deliveredLocations.length === 0) {
        newStatus = delivery.lastMessageAt ? 'not_delivered' : 'pending';
      } else {
        newStatus = 'partial';
      }

      await this.prismaRepository.deliveryTracking.update({
        where: { id: deliveryId },
        data: {
          status: newStatus,
          confirmedAt: new Date(),
        },
      });

      await this.logMessage(
        deliveryId,
        'system',
        `Recordatorios máximos alcanzados (${maxReminders}). Estado final: ${newStatus}`,
      );

      // Send email notification
      await this.emailService.sendDeliveryCompletedEmail({ ...delivery, status: newStatus }, newStatus);

      return;
    }

    // Send reminder message
    const reminderMessage = `Hola ${delivery.choferNombre}, te recordamos que tienes ${pendingLocations.length} ubicación(es) pendiente(s) de descarga para la pesada #${delivery.idPesada}. Por favor, confírmanos cuando hayas realizado la entrega.`;

    await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, reminderMessage);

    // Update reminder count
    await this.prismaRepository.deliveryTracking.update({
      where: { id: deliveryId },
      data: {
        reminderCount: delivery.reminderCount + 1,
        lastReminderAt: new Date(),
      },
    });

    await this.logMessage(deliveryId, 'system', `Recordatorio #${delivery.reminderCount + 1} enviado.`);

    this.logger.info(`Reminder ${delivery.reminderCount + 1}/${maxReminders} sent for pesada ${delivery.idPesada}`);
  }
}
