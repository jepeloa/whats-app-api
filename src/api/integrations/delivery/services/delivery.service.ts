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

    return `Eres un asistente de logística. Ayudas al camionero ${firstName} con la pesada #${delivery.idPesada}.

PESO TOTAL A ENTREGAR: ${delivery.pesoNeto.toLocaleString('es-AR')} ${delivery.pesoUn}
KILOS YA DESCARGADOS: ${kilosDescargados.toLocaleString('es-AR')} kg
KILOS RESTANTES: ${kilosRestantes.toLocaleString('es-AR')} kg

UBICACIONES PENDIENTES:
${pendingLocations || 'Ninguna'}

UBICACIONES ENTREGADAS:
${deliveredLocations || 'Ninguna'}

INSTRUCCIONES CRÍTICAS:
1. Responde de forma MUY BREVE y amigable (máximo 2 oraciones).
2. **IMPORTANTE**: Cuando el camionero confirme una entrega, SIEMPRE pregunta cuántos kilos descargó si no lo mencionó.
3. Si el camionero menciona un problema (accidente, rotura, robo, pérdida, derrame, etc.), registra el problema como observación.
4. Si quedan ubicaciones pendientes, recuérdale la siguiente ubicación.
5. **CORRECCIONES**: Si el camionero corrige los kilos de una ubicación ya entregada, usa "update_delivery" para actualizar.
6. **EL RESTO**: Si dice "el resto", "lo que queda", "todo lo demás", usa kilos: -1 y el sistema calculará automáticamente ${kilosRestantes.toLocaleString('es-AR')} kg.
7. Valida que los kilos no excedan ${kilosRestantes.toLocaleString('es-AR')} kg restantes.

FORMATO DE RESPUESTA:
- Para confirmar entrega CON kilos: mensaje + JSON al final
- Para preguntar kilos: solo mensaje (sin JSON)
- Para registrar problema: mensaje + JSON con observacion
- Para CORREGIR kilos ya reportados: mensaje + JSON con action "update_delivery"
- Para "el resto": mensaje + JSON con kilos: -1
- **MÚLTIPLES UBICACIONES**: Si el camionero confirma varias ubicaciones en un mensaje, genera un JSON por cada ubicación (cada uno en línea separada después del separador)

JSON (va en línea separada precedido por ---JSON---):
{"action": "confirm_delivery", "ubicacion": "NOMBRE_EXACTO", "kilos": NUMERO_O_-1, "observacion": "OBLIGATORIO si menciona problema"}
{"action": "update_delivery", "ubicacion": "NOMBRE_EXACTO", "kilos": NUMERO_O_-1, "observacion": "texto opcional"}
{"action": "report_issue", "observacion": "descripción del problema"}

EJEMPLOS:

Usuario: "Entregué en Aceitera"
Respuesta: "¡Bien ${firstName}! ¿Cuántos kilos descargaste en Aceitera?"

Usuario: "Entregué 15000 kilos en Aceitera"
Respuesta: "¡Perfecto ${firstName}! Confirmados 15.000 kg en Aceitera. Avisame cuando llegues a Terminal Puerto Rosario.
---JSON---
{"action": "confirm_delivery", "ubicacion": "Aceitera General Deheza", "kilos": 15000}"

Usuario: "Descargué el resto en la terminal"
Respuesta: "¡Perfecto ${firstName}! Confirmados los ${kilosRestantes.toLocaleString('es-AR')} kg restantes en Terminal Puerto Rosario.
---JSON---
{"action": "confirm_delivery", "ubicacion": "Terminal Puerto Rosario", "kilos": -1}"

Usuario: "Bajé 30000 kilos pero tuve un robo en la ruta"
Respuesta: "Lamento escuchar eso ${firstName}. Confirmados 30.000 kg y registré el robo.
---JSON---
{"action": "confirm_delivery", "ubicacion": "Terminal Puerto Rosario", "kilos": 30000, "observacion": "Robo en la ruta"}"

Usuario: "Entregué 25000 en el puerto, me faltaron 5000 por un accidente"
Respuesta: "Entendido ${firstName}. Confirmados 25.000 kg, registré el accidente.
---JSON---
{"action": "confirm_delivery", "ubicacion": "Puerto", "kilos": 25000, "observacion": "Faltaron 5000 kg por accidente"}"

Usuario: "No, en Aceitera eran 16000 kilos"
Respuesta: "Corregido ${firstName}. Actualicé a 16.000 kg en Aceitera.
---JSON---
{"action": "update_delivery", "ubicacion": "Aceitera General Deheza", "kilos": 16000}"

Usuario: "Tuve un accidente, se rompió la bolsa y perdí mercadería"
Respuesta: "Lamento escuchar eso ${firstName}. ¿Pudiste entregar algo en alguna ubicación? Registré el incidente.
---JSON---
{"action": "report_issue", "observacion": "Accidente con rotura de bolsa, pérdida de mercadería"}"

Usuario: "Descargué 10000 en la primera y 15000 en la segunda"
Respuesta: "¡Perfecto ${firstName}! Confirmados 10.000 kg en Molino Norte y 15.000 kg en Acopio Central.
---JSON---
{"action": "confirm_delivery", "ubicacion": "Molino Norte", "kilos": 10000}
{"action": "confirm_delivery", "ubicacion": "Acopio Central", "kilos": 15000}"

IMPORTANTE: 
- **SIEMPRE incluye "observacion" en el JSON cuando el camionero mencione: robo, accidente, pérdida, rotura, faltante, problema, derrame, o cualquier incidente.**
- Para correcciones de ubicaciones YA ENTREGADAS usa "update_delivery", no "confirm_delivery".
- Si dice "toneladas", multiplica por 1000 para obtener kilos.
- Si dice "el resto", "lo que queda", "todo", usa kilos: -1 (el sistema calcula los ${kilosRestantes.toLocaleString('es-AR')} kg automáticamente).
- Detecta frases como "me equivoqué", "en realidad eran", "no, eran", "corrijo" como señales de corrección.`;
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
   * Log a message for audit
   */
  private async logMessage(deliveryTrackingId: string, role: string, content: string) {
    await this.prismaRepository.deliveryMessage.create({
      data: {
        deliveryTrackingId,
        role,
        content,
      },
    });
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
      // No active delivery for this phone, ignore message
      return;
    }

    // Extract message content - pass the raw message object (not messageRaw.message)
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

    // Log incoming message for audit
    await this.logMessage(delivery.id, 'user', content);

    // Get conversation history for context
    const messages = await this.prismaRepository.deliveryMessage.findMany({
      where: { deliveryTrackingId: delivery.id },
      orderBy: { timestamp: 'asc' },
      take: 20, // Last 20 messages
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

    // Get AI response
    const aiResponse = await this.getAIResponse(openaiMessages);
    if (!aiResponse) {
      return;
    }

    this.logger.verbose(`Full AI response for pesada ${delivery.idPesada}: ${aiResponse}`);

    // Extract clean message (without JSON) for sending to user
    const { cleanMessage, jsonPart: initialJsonPart } = this.extractJsonFromResponse(aiResponse);
    let jsonPart = initialJsonPart;

    // Log full AI response for audit
    await this.logMessage(delivery.id, 'assistant', cleanMessage);

    // Retry: if no JSON found but there are pending locations and the response mentions delivery-related words
    if (!jsonPart && delivery.locations.some((l) => l.status === 'pending')) {
      const deliveryKeywords = /\b(confirm|kilos?|kg|descarg|entreg|listo|perfecto|excelente|anotado|registr)/i;
      if (deliveryKeywords.test(aiResponse)) {
        this.logger.warn(
          `No JSON action found but response seems delivery-related for pesada ${delivery.idPesada}. Retrying...`,
        );

        const retryMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          {
            role: 'system',
            content: `Tu respuesta anterior fue:
"${aiResponse}"

Genera SOLAMENTE el/los JSON de acción correspondientes a esa respuesta. Sin texto, sin explicación, solo JSON.
Cada JSON en una línea separada. Formato:
{"action": "confirm_delivery", "ubicacion": "NOMBRE_EXACTO", "kilos": NUMERO}
{"action": "update_delivery", "ubicacion": "NOMBRE_EXACTO", "kilos": NUMERO}
{"action": "report_issue", "observacion": "descripción"}

Ubicaciones pendientes: ${delivery.locations
              .filter((l) => l.status === 'pending')
              .map((l) => l.nombre)
              .join(', ')}
Ubicaciones entregadas: ${delivery.locations
              .filter((l) => l.status === 'delivered')
              .map((l) => l.nombre)
              .join(', ')}`,
          },
          { role: 'user', content: content },
        ];

        const retryResponse = await this.getAIResponse(retryMessages);
        if (retryResponse) {
          this.logger.info(`Retry response for pesada ${delivery.idPesada}: ${retryResponse}`);
          // The retry response should be pure JSON lines
          const retryExtract = this.extractJsonFromResponse(retryResponse);
          if (retryExtract.jsonPart) {
            jsonPart = retryExtract.jsonPart;
          } else {
            // Try the whole response as JSON directly
            jsonPart = retryResponse;
          }
        }
      }
    }

    // Process JSON action if present
    if (jsonPart) {
      await this.processAIResponse(delivery, jsonPart, instanceName);
    }

    // Send clean response to driver (without JSON)
    if (cleanMessage) {
      await this.sendWhatsAppMessage(instanceName, remoteJid, cleanMessage);
    }
  }

  /**
   * Extract JSON from AI response (separated by ---JSON---)
   */
  private extractJsonFromResponse(response: string): { cleanMessage: string; jsonPart: string | null } {
    // Check for ---JSON--- separator
    const jsonSeparator = '---JSON---';
    const separatorIndex = response.indexOf(jsonSeparator);

    if (separatorIndex !== -1) {
      const cleanMessage = response.substring(0, separatorIndex).trim();
      const jsonPart = response.substring(separatorIndex + jsonSeparator.length).trim();
      return { cleanMessage, jsonPart };
    }

    // Fallback: try to find any JSON action inline (all action types)
    const jsonMatches = response.match(
      /\{[^{}]*"action"\s*:\s*"(?:confirm_delivery|update_delivery|report_issue)"[^{}]*\}/g,
    );
    if (jsonMatches && jsonMatches.length > 0) {
      let cleanMessage = response;
      for (const m of jsonMatches) {
        cleanMessage = cleanMessage.replace(m, '');
      }
      cleanMessage = cleanMessage
        .replace(/```json\s*```/g, '')
        .replace(/```/g, '')
        .trim();
      return { cleanMessage, jsonPart: jsonMatches.join('\n') };
    }

    return { cleanMessage: response, jsonPart: null };
  }

  /**
   * Get AI response using OpenAI
   */
  private async getAIResponse(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string | null> {
    if (!this.openaiClient) {
      this.logger.error('OpenAI client not initialized');
      return null;
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 1000,
        temperature: 0.3,
      });

      return response.choices[0]?.message?.content || null;
    } catch (error) {
      this.logger.error(`OpenAI API error: ${error.message}`);
      return null;
    }
  }

  /**
   * Process AI response to detect delivery confirmations and issues
   */
  private async processAIResponse(
    delivery: DeliveryTracking & { locations: any[] },
    jsonString: string,
    instanceName: string,
  ) {
    // Parse JSON actions line by line — each line after ---JSON--- should be a JSON object
    const jsonMatches: string[] = [];
    const lines = jsonString
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      // Try to parse each line as JSON
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.action) {
          jsonMatches.push(line);
        }
      } catch {
        // Not a JSON line — try regex fallback for inline JSON
        const inlineMatches = line.match(/\{[^{}]*"action"\s*:\s*"[^"]+"[^{}]*\}/g);
        if (inlineMatches) {
          for (const m of inlineMatches) {
            try {
              const parsed = JSON.parse(m);
              if (parsed && parsed.action) {
                jsonMatches.push(m);
              }
            } catch {
              // skip malformed
            }
          }
        }
      }
    }

    if (jsonMatches.length === 0) {
      this.logger.warn(`No valid JSON actions found in AI response for pesada ${delivery.idPesada}: ${jsonString}`);
      return;
    }

    this.logger.info(`Found ${jsonMatches.length} JSON action(s) for pesada ${delivery.idPesada}`);

    // Process each action
    for (const jsonMatch of jsonMatches) {
      await this.processSingleAction(delivery, jsonMatch, instanceName);
    }
  }

  /**
   * Process a single action from AI response
   */
  private async processSingleAction(
    delivery: DeliveryTracking & { locations: any[] },
    jsonMatch: string,
    instanceName: string,
  ) {
    try {
      const action = JSON.parse(jsonMatch);

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

      // Handle issue reports (problems without delivery)
      if (action.action === 'report_issue' && action.observacion) {
        await this.addObservacion(freshDelivery.id, action.observacion);
        this.logger.info(`Issue reported for pesada ${freshDelivery.idPesada}: ${action.observacion}`);
        return;
      }

      // Handle delivery update (correction)
      if (action.action === 'update_delivery' && action.ubicacion) {
        // Find the location by name (case insensitive, partial match) - already delivered
        const location = freshDelivery.locations.find(
          (l) =>
            (l.nombre.toLowerCase().includes(action.ubicacion.toLowerCase()) ||
              action.ubicacion.toLowerCase().includes(l.nombre.toLowerCase())) &&
            l.status === 'delivered',
        );

        if (location) {
          const oldKilos = location.kilosDescargados || 0;
          let newKilos = action.kilos;

          // Handle "resto" - calculate remaining
          if (action.kilos === -1 || action.kilos === 'resto') {
            // For update, calculate what's left considering other locations
            const otrosKilos = freshDelivery.locations
              .filter((l) => l.status === 'delivered' && l.kilosDescargados && l.id !== location.id)
              .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);
            newKilos = freshDelivery.pesoNeto - otrosKilos;
          }

          // Update the location
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

          // Log the correction
          await this.logMessage(
            freshDelivery.id,
            'system',
            `Corrección en "${location.nombre}": ${oldKilos.toLocaleString('es-AR')} kg → ${newKilos.toLocaleString('es-AR')} kg`,
          );

          // Add observacion if provided
          if (action.observacion) {
            await this.addObservacion(freshDelivery.id, `${location.nombre} (corrección): ${action.observacion}`);
          }
        }
        return;
      }

      // Handle delivery confirmation
      if (action.action === 'confirm_delivery' && action.ubicacion) {
        let kilosToDeliver = action.kilos;

        // Handle "resto" - deliver remaining kilos
        if (action.kilos === -1 || action.kilos === 'resto') {
          kilosToDeliver = kilosRestantes;
          this.logger.info(`Auto-calculating "resto": ${kilosRestantes} kg for pesada ${freshDelivery.idPesada}`);
        }

        // Validate kilos
        if (kilosToDeliver !== undefined && kilosToDeliver > kilosRestantes) {
          this.logger.warn(
            `Kilos exceden el límite: ${kilosToDeliver} > ${kilosRestantes} restantes para pesada ${freshDelivery.idPesada}`,
          );
        }

        // Find the location by name (case insensitive, partial match)
        const location = freshDelivery.locations.find(
          (l) =>
            (l.nombre.toLowerCase().includes(action.ubicacion.toLowerCase()) ||
              action.ubicacion.toLowerCase().includes(l.nombre.toLowerCase())) &&
            l.status === 'pending',
        );

        if (location) {
          // Mark location as delivered with kilos
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

          // Log the confirmation
          const kilosText = kilosToDeliver ? ` (${kilosToDeliver.toLocaleString('es-AR')} kg)` : '';
          await this.logMessage(
            freshDelivery.id,
            'system',
            `Ubicación "${location.nombre}" marcada como entregada${kilosText}.`,
          );

          // Add observacion if provided
          if (action.observacion) {
            await this.addObservacion(freshDelivery.id, `${location.nombre}: ${action.observacion}`);
          }

          // Check if all locations are delivered
          await this.checkDeliveryComplete(freshDelivery.id, instanceName);
        }
      }
    } catch (error) {
      this.logger.error(`Error parsing AI action: ${error.message}`);
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
      // All locations delivered - mark as completed
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
      })),
      conversation: delivery.messages.map((m) => ({
        role: m.role,
        content: m.content,
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
