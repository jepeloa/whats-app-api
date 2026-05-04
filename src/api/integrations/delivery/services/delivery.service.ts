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
import { PesadaQueryService, UbicacionData } from './pesada-query.service';

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
                'close_delivery',
              ],
              description:
                'confirm_delivery: confirmar entrega en ubicación. update_delivery: corregir kilos ya entregados. report_issue: reportar problema. request_location: pedir ubicación GPS. chat: conversación general. query_pending: consulta sobre pesadas pendientes. close_delivery: cerrar pesada (el camionero terminó y no va a descargar en más ubicaciones).',
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
    action: 'confirm_delivery' | 'update_delivery' | 'report_issue' | 'request_location' | 'chat' | 'query_pending' | 'close_delivery';
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
    private readonly pesadaQueryService?: PesadaQueryService,
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

    const filtered = data.metadata?.ubicacionesFiltradas === true;
    const comentario = data.metadata?.comentarioBalanza;
    const filterNote = filtered && comentario
      ? `\n\nNota de balanza: "${comentario}"`
      : '';

    return `Hola ${data.choferNombre}! Registramos en nuestro sistema el traslado con el camión dominio ${data.patente} del producto ${data.artNombre}, desde ${data.origen} a ${data.ubicaciones.length > 1 ? 'las siguientes ubicaciones' : data.ubicaciones[0]?.nombre} por ${data.pesoNeto} ${data.pesoUn}. ¿Podrás confirmarnos la descarga?${filterNote}

${data.ubicaciones.length > 1 ? `Ubicaciones de descarga:\n${ubicacionesList}` : ''}`;
  }

  /**
   * Use OpenAI to filter locations based on the balance operator's comment.
   * If the comment is unclear or AI can't determine relevant locations, returns all locations (safe fallback).
   */
  async filterLocationsByComment(comment: string, locations: UbicacionData[]): Promise<UbicacionData[]> {
    if (!this.openaiClient || !comment || locations.length === 0) {
      return locations;
    }

    const cleanComment = comment.replace(/\r\n/g, '\n').trim();
    if (!cleanComment) return locations;

    const locationList = locations.map((l) => `- ID: ${l.ub_id} | Nombre: ${l.ub_nombre}`).join('\n');

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4.1',
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'location_filter',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                filtered_ids: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of ub_id values that match the comment. Empty array if cannot determine.',
                },
                confidence: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Confidence level in the filtering decision.',
                },
                reasoning: {
                  type: 'string',
                  description: 'Brief explanation of the filtering decision.',
                },
              },
              required: ['filtered_ids', 'confidence', 'reasoning'],
              additionalProperties: false,
            },
          },
        },
        messages: [
          {
            role: 'system',
            content: `Eres un asistente que filtra ubicaciones de descarga basándose en el comentario del operador de balanza.

El operador escribe en lenguaje libre, a veces abreviado. IMPORTANTE: distinguí entre información del camión y ubicaciones de destino.

Términos que NO son ubicaciones (se refieren al camión o producto):
- "TOLVA 7-8-9" = tolvas/compartimentos del camión. NO son tambos ni ubicaciones de descarga.
- "ELAB 60% MAIZ PROPIO" = información de elaboración del producto, NO una ubicación.
- Cualquier referencia a tolvas, compartimentos, carga, mezcla, elaboración = NO es ubicación.

Términos que SÍ son ubicaciones de descarga:
- "TAMBO 9" = TAMBO 9 (todas sus sub-ubicaciones: Silo 1, Silo 2, etc.)
- "TAMBO 2 SILO 1" = solo TAMBO 2 - Silo 1
- "TODO TAMBO 6" = todas las sub-ubicaciones de TAMBO 6

Reglas:
1. Devolvé SOLO los ub_id de ubicaciones que el comentario menciona EXPLÍCITAMENTE como destino de descarga.
2. Si el comentario menciona "TAMBO X", incluí TODAS las sub-ubicaciones de ese tambo (ej: Silo 1, Silo 2).
3. "TOLVA" NUNCA es una ubicación. Ignorá completamente las referencias a tolvas.
4. Si el comentario NO menciona ubicaciones específicas (solo tiene info de producto, tolvas, elaboración, etc.), devolvé array vacío.
5. Si no estás seguro, devolvé array vacío (es mejor mostrar todas que filtrar mal).
6. Confidence "high" = el comentario claramente nombra tambos/ubicaciones de destino. "medium" = probable pero no seguro. "low" = no se puede determinar.`,
          },
          {
            role: 'user',
            content: `Comentario del operador de balanza:\n"${cleanComment}"\n\nUbicaciones disponibles:\n${locationList}\n\n¿Cuáles ubicaciones corresponden al comentario?`,
          },
        ],
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return locations;

      const result = JSON.parse(content) as { filtered_ids: string[]; confidence: string; reasoning: string };

      this.logger.info(
        `filterLocationsByComment: confidence=${result.confidence}, reasoning="${result.reasoning}", filtered=${result.filtered_ids.length}/${locations.length}`,
      );

      // Only apply filter if confidence is high and we got results
      if (result.confidence === 'low' || result.filtered_ids.length === 0) {
        this.logger.info('filterLocationsByComment: low confidence or empty result, returning all locations');
        return locations;
      }

      const filtered = locations.filter((l) => result.filtered_ids.includes(l.ub_id));

      // Safety: if filter removed everything, return all
      if (filtered.length === 0) {
        this.logger.warn('filterLocationsByComment: filter removed all locations, returning all');
        return locations;
      }

      this.logger.info(`filterLocationsByComment: reduced ${locations.length} → ${filtered.length} locations`);
      return filtered;
    } catch (error) {
      this.logger.error(`filterLocationsByComment error: ${error.message}`);
      return locations; // Safe fallback
    }
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

    return `Eres un asistente de logística para el camionero ${firstName}. Tu trabajo principal es gestionar la pesada #${delivery.idPesada}, pero también podés responder preguntas generales.

PESO TOTAL CARGADO: ${delivery.pesoNeto.toLocaleString('es-AR')} ${delivery.pesoUn}
KILOS YA DESCARGADOS: ${kilosDescargados.toLocaleString('es-AR')} kg
KILOS RESTANTES: ${kilosRestantes.toLocaleString('es-AR')} kg

UBICACIONES PENDIENTES:
${pendingLocations || 'Ninguna'}

UBICACIONES ENTREGADAS:
${deliveredLocations || 'Ninguna'}

REGLAS CRÍTICAS:
1. Respondé MUY BREVE (máximo 2-3 oraciones). Sé amigable, estos son camioneros que escriben rápido.
2. IMPORTANTE: NO asumas que el camionero va a descargar en TODAS las ubicaciones. Puede descargar en una, en algunas o en todas. Nunca le digas "te falta ir a X" ni listes las pendientes automáticamente.
3. Después de confirmar una entrega, hacé una pregunta ABIERTA: "¿Descargaste en algún otro punto?" o "¿Necesitás registrar otra descarga?". NO menciones nombres de ubicaciones pendientes.
4. Si el camionero menciona kilos Y un problema (pérdida, accidente, rotura, etc.), usá "confirm_delivery" con los kilos que SÍ descargó + la observación.
5. Solo usá "report_issue" SIN ubicación cuando el problema es GENERAL (no asociado a una ubicación específica).
6. Si el camionero NO pudo descargar NADA en una ubicación (cerrada, no estaba el dueño, etc.), usá "confirm_delivery" con kilos:0 y la observación.
7. Si dice "el resto", "lo que queda", "todo", usa kilos: -1 (el sistema calcula ${kilosRestantes.toLocaleString('es-AR')} kg).
8. Valida que los kilos no excedan ${kilosRestantes.toLocaleString('es-AR')} kg restantes.
9. Después de CADA confirm_delivery: agregá "request_location" como siguiente acción. En el mensaje pedí "📍 ¿Podés compartirme la ubicación?". El GPS es OPCIONAL — si el camionero no lo envía, no insistas. NO menciones ubicaciones pendientes en el mensaje de GPS.
10. Si el camionero confirma varias ubicaciones en un mensaje, generá un action confirm_delivery + request_location por cada una.
11. Si dice "toneladas", multiplicá por 1000.
12. Para CORRECCIONES: "me equivoqué", "en realidad eran", "corrijo", "cambiá los kilos" → usá "update_delivery" con la ubicación y los kilos nuevos.
13. Si el camionero responde solo con un NÚMERO (ej: "5000") después de que preguntaste los kilos, SIEMPRE generá confirm_delivery para la ubicación que estás preguntando.
14. Si el camionero dice "2" o un número de ubicación sin kilos, preguntale cuántos kilos descargó ahí.
15. CIERRE: Si el camionero dice "listo", "ya terminé", "cierro", "no voy a más", "terminé todo", "ya está" → usá "close_delivery". Esto cierra la pesada y marca las ubicaciones pendientes como no descargadas.
16. Si TODAS las ubicaciones ya están entregadas y el camionero responde (por ejemplo "ok", "no", "listo"), respondé brevemente. El sistema se encarga de cerrar.
17. Si el camionero pregunta "¿a dónde más puedo ir?" o "¿qué ubicaciones tengo?", AHÍ SÍ listale las ubicaciones pendientes. Solo cuando él lo pide.
18. Si en un turno anterior YA listaste las pesadas/ubicaciones pendientes y el camionero responde con frases cortas o de cierre ("ok", "dale", "listo", "cerrá", "ya está", "gracias"), NO repitas el listado. Usá "close_delivery" si quiere cerrar, o "chat" con una respuesta breve. La acción "query_pending" solo va cuando el camionero PREGUNTA explícitamente por sus pendientes.

CHAT GENERAL:
- Preguntas no relacionadas con la entrega → action "chat".
- "cuántas pesadas tengo" → action "query_pending".
- "a dónde me queda ir" / "qué ubicaciones tengo" → listá las pendientes, action "chat".

ACCIONES DISPONIBLES:
- "confirm_delivery": confirmar entrega en ubicación (requiere ubicacion, kilos, observacion opcional). TAMBIÉN usar para ubicaciones donde no se descargó nada (kilos:0 + observacion).
- "update_delivery": corregir kilos ya entregados (requiere ubicacion, kilos nuevos).
- "report_issue": problema general NO asociado a ubicación específica (requiere observacion, ubicacion debe ser null).
- "request_location": pedir GPS al camionero. Va después de confirm_delivery. GPS es OPCIONAL.
- "chat": conversación general.
- "query_pending": consultar pesadas pendientes.
- "close_delivery": cerrar la pesada. El camionero terminó y no va a descargar en más ubicaciones. Se cierran las pendientes automáticamente.

EJEMPLOS:

Camionero: "1 3000kg"
→ message: "¡Perfecto ${firstName}! Confirmados 3.000 kg en [ubicación 1]. 📍 ¿Podés compartirme la ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 1]","kilos":3000,"observacion":null}, {"action":"request_location","ubicacion":"[nombre ubicación 1]","kilos":null,"observacion":null}]

Camionero: "2 perdí la mitad, descargue 500"
→ message: "Registré 500 kg y el incidente en [ubicación 2]. 📍 ¿Podés compartirme la ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 2]","kilos":500,"observacion":"Pérdida parcial de carga"}, {"action":"request_location","ubicacion":"[nombre ubicación 2]","kilos":null,"observacion":null}]

Camionero: "en 2 no descargue, estaba cerrado"
→ message: "Entendido ${firstName}, registré que estaba cerrado. ¿Descargaste en algún otro punto?"
→ actions: [{"action":"confirm_delivery","ubicacion":"[nombre ubicación 2]","kilos":0,"observacion":"Local cerrado"}, {"action":"request_location","ubicacion":"[nombre ubicación 2]","kilos":null,"observacion":null}]

Camionero: "Entregué el resto en planta sur"
→ message: "¡Perfecto ${firstName}! Confirmados los ${kilosRestantes.toLocaleString('es-AR')} kg restantes en Planta Sur. 📍 ¿Podés compartirme la ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"Planta Sur","kilos":-1,"observacion":null}, {"action":"request_location","ubicacion":"Planta Sur","kilos":null,"observacion":null}]

Camionero: "listo ya terminé" / "no voy a más" / "cierro"
→ message: "Entendido ${firstName}, cerramos la pesada. ¡Gracias por tu trabajo!"
→ actions: [{"action":"close_delivery","ubicacion":null,"kilos":null,"observacion":null}]

Camionero: "me equivoqué, en Deposito Norte eran 8000"
→ message: "Listo ${firstName}, corregí a 8.000 kg en Depósito Norte."
→ actions: [{"action":"update_delivery","ubicacion":"Depósito Norte","kilos":8000,"observacion":null}]

Camionero: "Tuve un accidente en la ruta"
→ message: "Lamento eso ${firstName}. Registré el incidente. ¿Pudiste entregar algo?"
→ actions: [{"action":"report_issue","ubicacion":null,"kilos":null,"observacion":"Accidente en la ruta"}]

(Contexto: acabas de preguntar "cuántos kilos descargaste en Terminal Sur?")
Camionero: "5000"
→ message: "¡Perfecto ${firstName}! Confirmados 5.000 kg en Terminal Sur. 📍 ¿Podés compartirme la ubicación?"
→ actions: [{"action":"confirm_delivery","ubicacion":"Terminal Sur","kilos":5000,"observacion":null}, {"action":"request_location","ubicacion":"Terminal Sur","kilos":null,"observacion":null}]

(Contexto: TODAS las ubicaciones ya entregadas)
Camionero: "no tengo gps" / "listo" / "ok"
→ message: "Entendido ${firstName}, cerramos la pesada. ¡Gracias!"
→ actions: [{"action":"chat","ubicacion":null,"kilos":null,"observacion":null}]

Camionero: "¿a dónde más puedo ir?"
→ message: "Tus ubicaciones pendientes son: [listar pendientes]. ¿En cuál descargaste?"
→ actions: [{"action":"chat","ubicacion":null,"kilos":null,"observacion":null}]

IMPORTANTE:
- TODA descarga (con o sin problema) se registra con confirm_delivery + request_location.
- report_issue es SOLO para problemas generales sin ubicación.
- NO listes ubicaciones pendientes automáticamente. Solo cuando el camionero pregunta.
- Después de confirmar una entrega, preguntá abiertamente si descargó en otro punto.
- GPS es OPCIONAL. No insistas si el camionero no lo envía.
- Para correcciones usá "update_delivery" con la ubicación y los kilos correctos.
- Si el camionero envía algo inesperado (emojis, audio, foto), respondé amablemente y preguntá si necesita registrar algo.`;
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
      // If closed, delete old record to allow recreation
      if (['completed', 'partial', 'not_delivered'].includes(existingPesada.status)) {
        this.logger.info(`Deleting closed pesada #${data.idPesada} (status: ${existingPesada.status}) to recreate`);
        await this.prismaRepository.deliveryTracking.delete({
          where: { id: existingPesada.id },
        });
      } else {
        throw new Error(`La pesada #${data.idPesada} ya tiene un pedido activo en esta instancia. Cerrelo antes de recrearlo.`);
      }
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
      // No active delivery — check if this is GPS for a recently completed delivery
      const locationData = this.extractLocationFromMessage(messageRaw);
      if (locationData) {
        const recentDelivery = await this.prismaRepository.deliveryTracking.findFirst({
          where: {
            remoteJid,
            instanceId: instance.id,
            status: 'completed',
            confirmedAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }, // last 30 minutes
          },
          include: { locations: { orderBy: { orden: 'asc' } } },
          orderBy: { confirmedAt: 'desc' },
        });

        if (recentDelivery) {
          const locationWithoutGps = recentDelivery.locations.find(
            (l) => l.status === 'delivered' && l.latitude == null,
          );
          if (locationWithoutGps) {
            await this.prismaRepository.deliveryLocation.update({
              where: { id: locationWithoutGps.id },
              data: {
                latitude: locationData.latitude,
                longitude: locationData.longitude,
                gpsTimestamp: new Date(),
              },
            });
            const thankMsg = `📍 ¡Gracias! Registré la ubicación para ${locationWithoutGps.nombre}.`;
            await this.sendWhatsAppMessage(instanceName, remoteJid, thankMsg);
            this.logger.info(
              `Late GPS saved for completed delivery ${recentDelivery.idPesada}: ${locationWithoutGps.nombre}`,
            );
            return;
          }
        }
      }

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

    // Check for pending GPS (sent before delivery confirmation)
    const pendingGpsMsg = await this.prismaRepository.deliveryMessage.findFirst({
      where: {
        deliveryTrackingId: delivery.id,
        messageType: 'pending_gps',
      },
      orderBy: { timestamp: 'desc' },
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

    // If there's a pending GPS, tell the AI not to request location
    if (pendingGpsMsg) {
      openaiMessages.push({
        role: 'system',
        content:
          'IMPORTANTE: El camionero ya envió su ubicación GPS. NO uses request_location para esta entrega. Solo confirmá los kilos con confirm_delivery.',
      });
    }

    // Get AI response with structured outputs
    const aiResponse = await this.getAIResponse(openaiMessages);
    if (!aiResponse) {
      return;
    }

    this.logger.verbose(`AI structured response for pesada ${delivery.idPesada}: ${JSON.stringify(aiResponse)}`);

    // Log AI response for audit, including actions
    const actionsForAudit = aiResponse.actions.length > 0 ? aiResponse.actions : undefined;
    await this.logMessage(delivery.id, 'assistant', aiResponse.message, 'text', actionsForAudit);

    // First pass: handle query_pending to build full message
    // Dedup guard: if we already sent a query_pending listing in the last 3 messages, skip the append
    const recentAssistantMsgs = messages.filter((m) => m.role === 'assistant').slice(-3);
    const alreadyListedRecently = recentAssistantMsgs.some((m) => m.messageType === 'query_pending');
    for (const action of aiResponse.actions) {
      if (action.action === 'query_pending') {
        if (alreadyListedRecently) {
          this.logger.info(
            `Skipping query_pending listing for pesada ${delivery.idPesada} — already listed recently`,
          );
          continue;
        }
        const pendingInfo = await this.buildPendingDeliveriesInfo(remoteJid, instance.id);
        if (pendingInfo) {
          aiResponse.message = aiResponse.message ? `${aiResponse.message}\n\n${pendingInfo}` : pendingInfo;
          // Persist the appended listing so the AI sees it in next turns and doesn't re-list
          await this.logMessage(delivery.id, 'assistant', pendingInfo, 'query_pending');
        }
      }
    }

    // Send AI message to driver BEFORE processing DB actions
    // This ensures GPS request arrives before completion summary
    if (aiResponse.message) {
      await this.sendWhatsAppMessage(instanceName, remoteJid, aiResponse.message);
    }

    // Second pass: process DB actions (confirm_delivery, update_delivery, report_issue)
    for (const action of aiResponse.actions) {
      if (action.action === 'chat' || action.action === 'request_location' || action.action === 'query_pending') {
        continue;
      }

      await this.processSingleAction(delivery, action, instanceName);
    }

    // After AI processing: if all locations are delivered and we haven't asked for cierre yet,
    // send the pre-close prompt now (this is the NEXT turn after the last confirm_delivery).
    await this.maybeSendPreCloseAsk(delivery.id, instanceName);
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

      const thankMsg = `📍 ¡Perfecto! Registré la ubicación de tu celular para ${locationWithoutGps.nombre}. ¡Gracias!`;
      await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, thankMsg);
      await this.logMessage(delivery.id, 'assistant', thankMsg);

      this.logger.info(
        `GPS saved for location ${locationWithoutGps.nombre}: ${locationData.latitude}, ${locationData.longitude}`,
      );

      // After saving GPS, re-check if all locations are now complete
      await this.checkDeliveryComplete(delivery.id, instanceName);
    } else {
      // No delivered location awaiting GPS — check if there are pending locations (GPS arrived before confirmation)
      const pendingLocations = delivery.locations.filter((l: any) => l.status === 'pending');
      if (pendingLocations.length > 0) {
        // Save as pending GPS for auto-assignment when driver confirms kilos
        await this.logMessage(
          delivery.id,
          'system',
          `GPS recibido antes de confirmar entrega: ${locationData.latitude}, ${locationData.longitude}`,
          'pending_gps',
          locationData,
        );
        let infoMsg: string;
        if (pendingLocations.length === 1) {
          infoMsg = `📍 Recibí tu ubicación. ¿Cuántos kilos descargaste en *${pendingLocations[0].nombre}*?`;
        } else {
          const locationList = pendingLocations.map((l: any, i: number) => `${i + 1}. ${l.nombre}`).join('\n');
          infoMsg = `📍 Recibí tu ubicación. ¿A cuál de estos puntos corresponde y cuántos kilos descargaste?\n\n${locationList}`;
        }
        await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, infoMsg);
        await this.logMessage(delivery.id, 'assistant', infoMsg);
        this.logger.info(
          `Pending GPS saved for delivery ${delivery.idPesada}: ${locationData.latitude}, ${locationData.longitude}`,
        );
      } else {
        const infoMsg = '📍 Recibí tu ubicación. ¡Gracias!';
        await this.sendWhatsAppMessage(instanceName, delivery.remoteJid, infoMsg);
        await this.logMessage(delivery.id, 'assistant', infoMsg, 'location', locationData);
      }
    }

    // After handling the GPS, if all locations are now delivered, prompt for cierre.
    await this.maybeSendPreCloseAsk(delivery.id, instanceName);
  }

  /**
   * If all locations are delivered and we haven't already asked the driver to confirm
   * cierre, send the prompt now. Idempotent: safe to call after every turn.
   */
  private async maybeSendPreCloseAsk(deliveryId: string, instanceName: string) {
    const fresh = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: { orderBy: { orden: 'asc' } } },
    });
    if (!fresh || fresh.status === 'completed') return;

    const allDelivered = fresh.locations.length > 0 && fresh.locations.every((l) => l.status === 'delivered');
    if (!allDelivered) return;

    const alreadyAsked = await this.prismaRepository.deliveryMessage.findFirst({
      where: { deliveryTrackingId: deliveryId, messageType: 'pre_close_ask' },
    });
    if (alreadyAsked) return;

    const totalDescargado = fresh.locations
      .filter((l) => l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);

    const askMsg = `Ya no quedan ubicaciones por descargar (${totalDescargado.toLocaleString('es-AR')} kg registrados). Si querés cerrar la pesada, respondé *"cerrar"*. Si necesitás registrar otra descarga, podés seguir.`;
    await this.sendWhatsAppMessage(instanceName, fresh.remoteJid, askMsg);
    await this.logMessage(deliveryId, 'assistant', askMsg, 'pre_close_ask');
    this.logger.info(`Pre-close ask sent for ${fresh.idPesada}; awaiting "cerrar" or new descarga.`);
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
        model: 'gpt-4.1',
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
        model: 'gpt-4.1',
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

      // Handle close_delivery — driver is done, close pending locations with 0 kg
      if (action.action === 'close_delivery') {
        const pendingLocations = freshDelivery.locations.filter((l) => l.status === 'pending');

        // Mark all pending locations as delivered with 0 kg
        for (const loc of pendingLocations) {
          await this.prismaRepository.deliveryLocation.update({
            where: { id: loc.id },
            data: {
              status: 'delivered',
              deliveredAt: new Date(),
              kilosDescargados: 0,
              notes: 'No se informó descarga en esta ubicación',
            },
          });
          this.logger.info(`Location ${loc.nombre} closed with 0 kg for pesada ${freshDelivery.idPesada}`);
        }

        if (pendingLocations.length > 0) {
          const closedNames = pendingLocations.map((l) => l.nombre).join(', ');
          await this.logMessage(
            freshDelivery.id,
            'system',
            `Camionero solicitó cierre. Ubicaciones cerradas sin descarga: ${closedNames}`,
            'action',
            { action: 'close_delivery', closedLocations: closedNames },
          );
        }

        // Force completion (generates summary + PDF + email)
        await this.checkDeliveryComplete(freshDelivery.id, instanceName, true);
        return;
      }

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

          // If the updated location has no GPS yet, ask the driver for it
          if (location.latitude == null || location.longitude == null) {
            const gpsMsg = `📍 Ya registré la corrección en "${location.nombre}". ¿Podés compartirme la ubicación GPS de ese punto? Tocá el clip 📎 → Ubicación → Enviar ubicación actual.`;
            await this.sendWhatsAppMessage(instanceName, freshDelivery.remoteJid, gpsMsg);
            await this.logMessage(freshDelivery.id, 'assistant', gpsMsg, 'gps_ask_after_update', {
              ubicacion: location.nombre,
            });
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

          // Auto-assign pending GPS if driver sent location before confirming
          const pendingGps = await this.prismaRepository.deliveryMessage.findFirst({
            where: {
              deliveryTrackingId: freshDelivery.id,
              messageType: 'pending_gps',
            },
            orderBy: { timestamp: 'desc' },
          });

          if (pendingGps && pendingGps.actionData) {
            const gpsData = pendingGps.actionData as any;
            await this.prismaRepository.deliveryLocation.update({
              where: { id: location.id },
              data: {
                latitude: gpsData.latitude,
                longitude: gpsData.longitude,
                gpsTimestamp: new Date(),
              },
            });

            // Remove pending GPS so it's not reused
            await this.prismaRepository.deliveryMessage.delete({
              where: { id: pendingGps.id },
            });

            await this.logMessage(
              freshDelivery.id,
              'system',
              `GPS auto-asignado a "${location.nombre}": ${gpsData.latitude}, ${gpsData.longitude}`,
              'location',
              gpsData,
            );

            this.logger.info(`Pending GPS auto-assigned to ${location.nombre} for pesada ${freshDelivery.idPesada}`);
          }

          await this.checkDeliveryComplete(freshDelivery.id, instanceName);
          await this.maybeSendKilosMaxAsk(freshDelivery.id, instanceName);
        }
      }
    } catch (error) {
      this.logger.error(`Error processing action: ${error.message}`);
    }
  }

  /**
   * If the driver has registered all available kilos (descargados sum >= pesoNeto)
   * BUT there are still pending locations, ask once if he wants to close the pesada.
   * If all locations are already delivered we don't ask here (maybeSendPreCloseAsk
   * handles that case).
   */
  private async maybeSendKilosMaxAsk(deliveryId: string, instanceName: string) {
    const fresh = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: { orderBy: { orden: 'asc' } } },
    });
    if (!fresh || fresh.status === 'completed') return;

    const pending = fresh.locations.filter((l) => l.status === 'pending');
    if (pending.length === 0) return; // all delivered → other helper handles cierre

    const totalDescargado = fresh.locations
      .filter((l) => l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);

    if (totalDescargado < fresh.pesoNeto) return; // still kilos to go

    const alreadyAsked = await this.prismaRepository.deliveryMessage.findFirst({
      where: { deliveryTrackingId: deliveryId, messageType: 'kilos_max_ask' },
    });
    if (alreadyAsked) return;

    const askMsg = `Ya registramos los ${fresh.pesoNeto.toLocaleString('es-AR')} ${fresh.pesoUn} totales de la pesada. Si no vas a registrar más descargas, respondé *"cerrar"* para finalizar. Si descargaste en otro punto, contámelo.`;
    await this.sendWhatsAppMessage(instanceName, fresh.remoteJid, askMsg);
    await this.logMessage(deliveryId, 'assistant', askMsg, 'kilos_max_ask');
    this.logger.info(
      `Kilos-max ask sent for ${fresh.idPesada} (registrados ${totalDescargado} >= total ${fresh.pesoNeto}; ${pending.length} pendientes).`,
    );
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
  private async checkDeliveryComplete(deliveryId: string, instanceName: string, forceComplete = false) {
    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: { orderBy: { orden: 'asc' } }, messages: true },
    });

    if (!delivery) return;
    if (delivery.status === 'completed') return;

    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');

    if (pendingLocations.length === 0) {
      // Don't auto-close. The first time we detect all delivered, just mark it pending.
      // The pre-close prompt is sent on the NEXT driver turn (see maybeSendPreCloseAsk),
      // so it doesn't get bundled with the AI's confirmation message.
      if (!forceComplete) {
        const pending = await this.prismaRepository.deliveryMessage.findFirst({
          where: { deliveryTrackingId: deliveryId, messageType: 'pre_close_pending' },
        });
        if (!pending) {
          await this.logMessage(
            deliveryId,
            'system',
            'Todas las ubicaciones entregadas. Esperando respuesta del chofer para confirmar cierre.',
            'pre_close_pending',
          );
          this.logger.info(
            `All locations delivered for ${delivery.idPesada}; pre-close prompt deferred to next turn.`,
          );
        }
        return;
      }

      // forceComplete=true (driver said "cerrar" / explicit close_delivery) — close now.
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

      // Save results to SIGO database (traslado_descarga + bitacora + estado)
      await this.saveToSigo(delivery);
    }
  }

  /**
   * Save delivery results to SIGO SQL Server database
   * - INSERT rows into traslado_descarga (one per location)
   * - INSERT event into traslado_bitacora
   * - UPDATE traslado.tras_estado + tras_dt_cierre
   * Non-critical: errors are logged but don't break the flow
   */
  private async saveToSigo(delivery: any): Promise<void> {
    if (!this.pesadaQueryService) {
      this.logger.warn(`PesadaQueryService not available, skipping SIGO write for pesada ${delivery.idPesada}`);
      return;
    }

    try {
      // Find or create the traslado record in SIGO
      const traslado = await this.pesadaQueryService.findOrCreateTraslado(delivery);
      if (!traslado) {
        this.logger.warn(`Could not find or create traslado in SIGO for pesada ${delivery.idPesada}, skipping write-back`);
        return;
      }

      this.logger.info(`Using traslado ${traslado.tras_id} for pesada ${delivery.idPesada}, saving results to SIGO`);

      // Build location data with ub_id lookup
      const locationData: Array<{ nombre: string; kilosDescargados: number | null; ubId: string | null }> = [];
      for (const loc of delivery.locations) {
        const ubId = await this.pesadaQueryService.findUbicacionIdByName(loc.nombre);
        locationData.push({
          nombre: loc.nombre,
          kilosDescargados: loc.kilosDescargados,
          ubId,
        });
      }

      // INSERT into traslado_descarga
      await this.pesadaQueryService.saveDescarga(
        traslado.tras_id,
        delivery.idPesada,
        locationData,
        delivery.pesoUn || 'KG',
      );
      this.logger.info(`Saved ${locationData.length} descarga rows for traslado ${traslado.tras_id}`);

      // Calculate totals for bitacora observation
      const totalDescargado = delivery.locations
        .filter((l: any) => l.kilosDescargados)
        .reduce((sum: number, l: any) => sum + (l.kilosDescargados || 0), 0);
      const ubicacionesConCarga = delivery.locations.filter((l: any) => l.kilosDescargados && l.kilosDescargados > 0).length;

      // INSERT into traslado_bitacora
      const obsText = `Cerrado via WhatsApp. ${ubicacionesConCarga} ubicacion(es), ${totalDescargado} kg descargados`;
      await this.pesadaQueryService.saveBitacora(traslado.tras_id, 'cierre_whatsapp', obsText);

      // UPDATE traslado estado
      await this.pesadaQueryService.updateTrasladoEstado(traslado.tras_id, 'completado');

      // Save WhatsApp conversation log
      const chatMessages = delivery.messages
        ? delivery.messages.map((m: any) => ({
            role: m.role,
            content: m.content,
            type: m.messageType,
            timestamp: m.timestamp,
          }))
        : [];
      const choferTel = delivery.remoteJid?.replace('@s.whatsapp.net', '') || '';
      await this.pesadaQueryService.saveWsappLog(traslado.tras_id, choferTel, chatMessages);
      this.logger.info(`Saved wsapp_log for traslado ${traslado.tras_id}`);

      this.logger.info(`SIGO write-back completed for pesada ${delivery.idPesada} (traslado ${traslado.tras_id})`);
      await this.logMessage(delivery.id, 'system', `Resultados guardados en SIGO (traslado ${traslado.tras_id})`);
    } catch (error) {
      this.logger.error(`Error saving to SIGO for pesada ${delivery.idPesada}: ${error.message}`);
      // Don't fail the whole process if SIGO write fails
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
