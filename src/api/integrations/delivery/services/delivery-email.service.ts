import { Logger } from '@config/logger.config';
import { DeliveryTracking } from '@prisma/client';
import * as nodemailer from 'nodemailer';

interface DeliveryWithDetails extends DeliveryTracking {
  locations: Array<{
    nombre: string;
    direccion: string;
    status: string;
    deliveredAt?: Date | null;
  }>;
  messages?: Array<{
    role: string;
    content: string;
    timestamp: Date;
  }>;
}

export class DeliveryEmailService {
  private readonly logger = new Logger('DeliveryEmailService');
  private transporter: nodemailer.Transporter | null = null;

  constructor() {
    this.initTransporter();
  }

  private initTransporter() {
    const host = process.env.DELIVERY_SMTP_HOST;
    const port = parseInt(process.env.DELIVERY_SMTP_PORT || '587', 10);
    const user = process.env.DELIVERY_SMTP_USER;
    const pass = process.env.DELIVERY_SMTP_PASS;

    if (!host || !user || !pass) {
      this.logger.warn('SMTP configuration incomplete. Email notifications disabled.');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });

    this.logger.info('Email transporter initialized');
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'completed':
        return '✅';
      case 'partial':
        return '⚠️';
      case 'not_delivered':
        return '❌';
      case 'pending':
        return '⏳';
      default:
        return '📦';
    }
  }

  private getStatusLabel(status: string): string {
    switch (status) {
      case 'completed':
        return 'COMPLETADO';
      case 'partial':
        return 'ENTREGADO PARCIAL';
      case 'not_delivered':
        return 'NO ENTREGADO';
      case 'pending':
        return 'PENDIENTE';
      case 'in_progress':
        return 'EN PROGRESO';
      default:
        return status.toUpperCase();
    }
  }

  private formatDate(date: Date | null | undefined): string {
    if (!date) return 'N/A';
    return new Date(date).toLocaleString('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  }

  private buildEmailHtml(delivery: DeliveryWithDetails, finalStatus: string): string {
    const statusEmoji = this.getStatusEmoji(finalStatus);
    const statusLabel = this.getStatusLabel(finalStatus);

    const deliveredLocations = delivery.locations.filter((l) => l.status === 'delivered');
    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');

    let deliveredHtml = '';
    if (deliveredLocations.length > 0) {
      deliveredHtml = `
        <h3 style="color: #28a745;">✅ UBICACIONES ENTREGADAS (${deliveredLocations.length})</h3>
        <ul>
          ${deliveredLocations
            .map(
              (l) => `
            <li>
              <strong>${l.nombre}</strong><br/>
              ${l.direccion}<br/>
              <em>Entregado: ${this.formatDate(l.deliveredAt)}</em>
            </li>
          `,
            )
            .join('')}
        </ul>
      `;
    }

    let pendingHtml = '';
    if (pendingLocations.length > 0) {
      pendingHtml = `
        <h3 style="color: #dc3545;">❌ UBICACIONES NO ENTREGADAS (${pendingLocations.length})</h3>
        <ul>
          ${pendingLocations
            .map(
              (l) => `
            <li>
              <strong>${l.nombre}</strong><br/>
              ${l.direccion}
            </li>
          `,
            )
            .join('')}
        </ul>
      `;
    }

    let conversationHtml = '';
    if (delivery.messages && delivery.messages.length > 0) {
      conversationHtml = `
        <h3>📝 HISTORIAL DE CONVERSACIÓN</h3>
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; max-height: 400px; overflow-y: auto;">
          ${delivery.messages
            .map((m) => {
              const roleLabel =
                m.role === 'user' ? '🚛 Camionero' : m.role === 'assistant' ? '🤖 Sistema' : '⚙️ Sistema';
              const bgColor = m.role === 'user' ? '#e3f2fd' : m.role === 'assistant' ? '#f5f5f5' : '#fff3cd';
              return `
              <div style="margin-bottom: 10px; padding: 10px; background: ${bgColor}; border-radius: 5px;">
                <strong>${roleLabel}</strong> <small style="color: #666;">${this.formatDate(m.timestamp)}</small><br/>
                ${m.content}
              </div>
            `;
            })
            .join('')}
        </div>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .status { font-size: 24px; font-weight: bold; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          .info-table td { padding: 8px; border-bottom: 1px solid #ddd; }
          .info-table td:first-child { font-weight: bold; width: 40%; }
          ul { list-style-type: none; padding-left: 0; }
          li { margin-bottom: 15px; padding: 10px; background: #f8f9fa; border-radius: 5px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="status">${statusEmoji} Pesada #${delivery.idPesada} - ${statusLabel}</div>
          </div>
          
          <h3>📋 INFORMACIÓN DEL TRASLADO</h3>
          <table class="info-table">
            <tr><td>Chofer:</td><td>${delivery.choferNombre}</td></tr>
            <tr><td>Patente:</td><td>${delivery.patente}</td></tr>
            <tr><td>Producto:</td><td>${delivery.artNombre}</td></tr>
            <tr><td>Peso:</td><td>${delivery.pesoNeto} ${delivery.pesoUn}</td></tr>
            <tr><td>Origen:</td><td>${delivery.origen}</td></tr>
            <tr><td>Creado:</td><td>${this.formatDate(delivery.createdAt)}</td></tr>
            <tr><td>Finalizado:</td><td>${this.formatDate(delivery.confirmedAt)}</td></tr>
            <tr><td>Recordatorios enviados:</td><td>${delivery.reminderCount}</td></tr>
          </table>
          
          ${deliveredHtml}
          ${pendingHtml}
          ${conversationHtml}
          
          <hr/>
          <p style="color: #666; font-size: 12px;">
            Este es un correo automático generado por el sistema de tracking de entregas.
          </p>
        </div>
      </body>
      </html>
    `;
  }

  private buildEmailText(delivery: DeliveryWithDetails, finalStatus: string): string {
    const statusLabel = this.getStatusLabel(finalStatus);

    const deliveredLocations = delivery.locations.filter((l) => l.status === 'delivered');
    const pendingLocations = delivery.locations.filter((l) => l.status === 'pending');

    let text = `
RESUMEN PESADA #${delivery.idPesada}
================================
Estado: ${statusLabel}

INFORMACIÓN DEL TRASLADO
------------------------
Chofer: ${delivery.choferNombre}
Patente: ${delivery.patente}
Producto: ${delivery.artNombre}
Peso: ${delivery.pesoNeto} ${delivery.pesoUn}
Origen: ${delivery.origen}
Creado: ${this.formatDate(delivery.createdAt)}
Finalizado: ${this.formatDate(delivery.confirmedAt)}
Recordatorios: ${delivery.reminderCount}
`;

    if (deliveredLocations.length > 0) {
      text += `
UBICACIONES ENTREGADAS (${deliveredLocations.length})
-------------------------------
${deliveredLocations.map((l) => `• ${l.nombre} - ${l.direccion} (${this.formatDate(l.deliveredAt)})`).join('\n')}
`;
    }

    if (pendingLocations.length > 0) {
      text += `
UBICACIONES NO ENTREGADAS (${pendingLocations.length})
-------------------------------
${pendingLocations.map((l) => `• ${l.nombre} - ${l.direccion}`).join('\n')}
`;
    }

    return text;
  }

  async sendDeliveryCompletedEmail(delivery: DeliveryWithDetails, finalStatus: string) {
    if (!this.transporter) {
      this.logger.warn('Email transporter not configured. Skipping email notification.');
      return;
    }

    const recipients = delivery.emailRecipients || process.env.DELIVERY_EMAIL_TO || '';
    if (!recipients) {
      this.logger.warn('No email recipients configured. Skipping email notification.');
      return;
    }

    const from = process.env.DELIVERY_EMAIL_FROM || process.env.DELIVERY_SMTP_USER;
    const statusLabel = this.getStatusLabel(finalStatus);
    const subject = `${this.getStatusEmoji(finalStatus)} Pesada #${delivery.idPesada} - ${statusLabel}`;

    try {
      await this.transporter.sendMail({
        from,
        to: recipients,
        subject,
        text: this.buildEmailText(delivery, finalStatus),
        html: this.buildEmailHtml(delivery, finalStatus),
      });

      this.logger.info(`Email sent for pesada ${delivery.idPesada} to ${recipients}`);
    } catch (error) {
      this.logger.error(`Error sending email: ${error.message}`);
    }
  }
}
