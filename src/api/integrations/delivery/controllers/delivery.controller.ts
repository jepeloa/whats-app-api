import { InstanceDto } from '@api/dto/instance.dto';
import { Logger } from '@config/logger.config';

import { CloseDeliveryDto, CreateDeliveryDto, DeliveryStatusDto, NotifyPesadaDto, NotifyPesadaTestDto } from '../dto/delivery.dto';
import { PesadaQueryService } from '../services/pesada-query.service';
import { DeliveryService } from '../services/delivery.service';

export class DeliveryController {
  private readonly logger = new Logger('DeliveryController');

  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly pesadaQueryService: PesadaQueryService,
  ) {}

  /**
   * Create a new delivery tracking
   */
  async create(instance: InstanceDto, data: CreateDeliveryDto) {
    this.logger.info(`Creating delivery for instance ${instance.instanceName}`);
    return this.deliveryService.create(instance.instanceName, data);
  }

  /**
   * Get delivery status
   */
  async getStatus(instance: InstanceDto, data: DeliveryStatusDto) {
    return this.deliveryService.getStatus(instance.instanceName, data.idPesada);
  }

  /**
   * List deliveries
   */
  async list(instance: InstanceDto, query: { status?: string; limit?: number; offset?: number }) {
    return this.deliveryService.list(instance.instanceName, query.status, query.limit || 20, query.offset || 0);
  }

  /**
   * Close a delivery manually
   */
  async close(instance: InstanceDto, data: CloseDeliveryDto) {
    return this.deliveryService.close(instance.instanceName, data.idPesada, data.reason);
  }

  /**
   * Get audit trail for a delivery
   */
  async getAudit(instance: InstanceDto, data: DeliveryStatusDto) {
    return this.deliveryService.getAudit(instance.instanceName, data.idPesada);
  }

  /**
   * Process incoming message (called by chatbot controller)
   */
  async processMessage(instanceName: string, remoteJid: string, msg: any) {
    await this.deliveryService.processIncomingMessage(instanceName, remoteJid, msg);
  }

  async notifyPesada(instance: InstanceDto, data: NotifyPesadaDto) {
    this.logger.info(`Notifying pesada ${data.idPesada} for instance ${instance.instanceName}`);
    return this.pesadaQueryService.notifyPesada(instance.instanceName, data.idPesada);
  }

  async notifyPesadaTest(instance: InstanceDto, data: NotifyPesadaTestDto) {
    this.logger.info(`Test notify pesada ${data.idPesada} to ${data.testPhone} for instance ${instance.instanceName}`);
    return this.pesadaQueryService.notifyPesada(instance.instanceName, data.idPesada, data.testPhone);
  }
}
