import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { DeliveryStatus, DeliveryTracking } from '@prisma/client';
import { getConversationMessage } from '@utils/getConversationMessage';
import OpenAI from 'openai';

import { CreateDeliveryDto } from '../dto/delivery.dto';
import { DeliveryEmailService } from './delivery-email.service';

export class DeliveryService {
  private readonly logger = new Logger('DeliveryService');
  private openaiClient: OpenAI;

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
      .map((l) => `- ${l.nombre}: ${l.direccion}`)
      .join('\n');

    return `Eres un asistente de logística amable y conciso. Estás ayudando al camionero ${delivery.choferNombre} con la pesada #${delivery.idPesada}.

INFORMACIÓN DEL TRASLADO:
- Patente: ${delivery.patente}
- Producto: ${delivery.artNombre}
- Origen: ${delivery.origen}
- Peso: ${delivery.pesoNeto} ${delivery.pesoUn}

UBICACIONES PENDIENTES DE DESCARGA:
${pendingLocations || 'Ninguna'}

UBICACIONES YA ENTREGADAS:
${deliveredLocations || 'Ninguna todavía'}

TU TAREA:
1. Cuando el camionero indique que llegó o que está descargando, pregúntale CUÁL ubicación está descargando si hay más de una pendiente.
2. Cuando confirme una descarga específica, responde con el siguiente JSON (IMPORTANTE: incluye este JSON en tu respuesta):
   {"action": "confirm_delivery", "ubicacion": "NOMBRE_EXACTO_DE_LA_UBICACION"}
3. Sé amable, breve y profesional.
4. Si el camionero tiene problemas o dudas, ayúdalo y ofrece soporte.
5. Si todas las ubicaciones fueron entregadas, felicítalo y despídete.

IMPORTANTE: Solo incluye el JSON cuando el camionero CONFIRME una descarga específica, no cuando solo diga que llegó o está en camino.`;
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
    const existingActive = await this.prismaRepository.deliveryTracking.findFirst({
      where: {
        remoteJid,
        instanceId: instance.id,
        status: { in: ['pending', 'in_progress', 'partial'] },
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

    // Extract message content
    const content = getConversationMessage(messageRaw.message);
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

    // Log AI response
    await this.logMessage(delivery.id, 'assistant', aiResponse);

    // Check if AI response contains a delivery confirmation
    await this.processAIResponse(delivery, aiResponse, instanceName);

    // Send response to driver
    // Remove the JSON from the message before sending
    const cleanResponse = aiResponse.replace(/\{"action":\s*"confirm_delivery".*?\}/g, '').trim();
    if (cleanResponse) {
      await this.sendWhatsAppMessage(instanceName, remoteJid, cleanResponse);
    }
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
        max_tokens: 500,
        temperature: 0.7,
      });

      return response.choices[0]?.message?.content || null;
    } catch (error) {
      this.logger.error(`OpenAI API error: ${error.message}`);
      return null;
    }
  }

  /**
   * Process AI response to detect delivery confirmations
   */
  private async processAIResponse(
    delivery: DeliveryTracking & { locations: any[] },
    aiResponse: string,
    instanceName: string,
  ) {
    // Try to extract JSON action from response
    const jsonMatch = aiResponse.match(/\{"action":\s*"confirm_delivery".*?\}/);
    if (!jsonMatch) {
      return;
    }

    try {
      const action = JSON.parse(jsonMatch[0]);
      if (action.action === 'confirm_delivery' && action.ubicacion) {
        // Find the location by name (case insensitive)
        const location = delivery.locations.find(
          (l) => l.nombre.toLowerCase() === action.ubicacion.toLowerCase() && l.status === 'pending',
        );

        if (location) {
          // Mark location as delivered
          await this.prismaRepository.deliveryLocation.update({
            where: { id: location.id },
            data: {
              status: 'delivered',
              deliveredAt: new Date(),
            },
          });

          this.logger.info(`Location ${location.nombre} marked as delivered for pesada ${delivery.idPesada}`);

          // Log the confirmation
          await this.logMessage(delivery.id, 'system', `Ubicación "${location.nombre}" marcada como entregada.`);

          // Check if all locations are delivered
          await this.checkDeliveryComplete(delivery.id, instanceName);
        }
      }
    } catch (error) {
      this.logger.error(`Error parsing AI action: ${error.message}`);
    }
  }

  /**
   * Check if all locations are delivered and update delivery status
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async checkDeliveryComplete(deliveryId: string, _instanceName: string) {
    const delivery = await this.prismaRepository.deliveryTracking.findUnique({
      where: { id: deliveryId },
      include: { locations: true, messages: true },
    });

    if (!delivery) return;

    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');

    if (pendingLocations.length === 0) {
      // All locations delivered - mark as completed
      await this.prismaRepository.deliveryTracking.update({
        where: { id: deliveryId },
        data: {
          status: 'completed',
          confirmedAt: new Date(),
        },
      });

      this.logger.info(`Delivery ${delivery.idPesada} completed! All locations delivered.`);

      // Log completion
      await this.logMessage(deliveryId, 'system', 'Todas las ubicaciones fueron entregadas. Pesada completada.');

      // Send completion email
      await this.emailService.sendDeliveryCompletedEmail(delivery, 'completed');
    }
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
        status: delivery.status,
        reminderCount: delivery.reminderCount,
        locations: delivery.locations.map((l) => ({
          id: l.id,
          nombre: l.nombre,
          direccion: l.direccion,
          status: l.status,
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
