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
    return this.createDeliveryFromPesada(instance.instanceName, data.idPesada);
  }

  async notifyPesadaTest(instance: InstanceDto, data: NotifyPesadaTestDto) {
    this.logger.info(`Test notify pesada ${data.idPesada} to ${data.testPhone} for instance ${instance.instanceName}`);
    return this.createDeliveryFromPesada(instance.instanceName, data.idPesada, data.testPhone);
  }

  /**
   * Query SQL Server for pesada data, build a CreateDeliveryDto, and call deliveryService.create()
   * This ensures a DeliveryTracking record is created so responses are matched correctly.
   */
  private async createDeliveryFromPesada(instanceName: string, idPesada: number, testPhone?: string) {
    const pesada = await this.pesadaQueryService.queryPesada(idPesada);
    if (!pesada) {
      throw new Error(`Pesada ${idPesada} no encontrada en SQL Server`);
    }

    let ubicaciones = await this.pesadaQueryService.queryUbicaciones(pesada.RUCADestino);

    // Pre-filter locations by balance operator comment using AI
    const comentario = pesada.Comentarios?.trim() || '';
    let ubicacionesFiltradas = false;
    if (comentario && ubicaciones.length > 1) {
      const originalCount = ubicaciones.length;
      ubicaciones = await this.deliveryService.filterLocationsByComment(comentario, ubicaciones);
      ubicacionesFiltradas = ubicaciones.length < originalCount;
      if (ubicacionesFiltradas) {
        this.logger.info(`Pesada ${idPesada}: filtered ${originalCount} → ${ubicaciones.length} locations by comment`);
      }
    }

    let phoneNumber: string;
    if (testPhone) {
      phoneNumber = testPhone;
    } else {
      if (!pesada.TelefonoChofer || pesada.TelefonoChofer.trim() === '') {
        throw new Error(`Pesada ${idPesada}: el chofer no tiene teléfono registrado`);
      }
      phoneNumber = this.pesadaQueryService.formatPhoneNumber(pesada.TelefonoChofer);
    }

    const deliveryLocations = ubicaciones.length > 0
      ? ubicaciones.map((u, i) => ({
          nombre: u.ub_nombre,
          direccion: u.ub_nombre,
          orden: i + 1,
        }))
      : [{
          nombre: pesada.Destino.trim(),
          direccion: pesada.Destino.trim(),
          orden: 1,
        }];

    const createDto: CreateDeliveryDto = {
      idPesada: String(idPesada),
      phoneNumber,
      choferNombre: pesada.Chofer.trim(),
      patente: pesada.Patente.trim(),
      artNombre: pesada.Articulo.trim(),
      origen: pesada.Deposito.trim(),
      pesoNeto: pesada.PesoNeto,
      pesoUn: 'KG',
      ubicaciones: deliveryLocations,
      metadata: {
        rucaDestino: pesada.RUCADestino,
        comprador: pesada.Comprador?.trim(),
        transportista: pesada.Transportista?.trim(),
        acoplado: pesada.Acoplado?.trim(),
        destino: pesada.Destino?.trim(),
        cuitComprador: pesada.CUITComprador?.trim() || null,
        cuitChofer: pesada.CUITChofer?.trim() || null,
        cuitTransportista: pesada.CUITTransportista?.trim() || null,
        tara: pesada.Tara ?? null,
        pesoBruto: pesada.PesoBruto ?? null,
        km: pesada.KM ?? null,
        nroPuntoVentaPesadaSalida: pesada.NroPuntoVentaPesadaSalida ?? null,
        nroPesadaSalida: pesada.NroPesadaSalida ?? null,
        letraPesadaSalida: pesada.LetraPesadaSalida?.trim() || null,
        tipoComprobante: pesada.TipoComprobante?.trim() || null,
        codigoArticulo: pesada.CodigoArticulo?.trim() || null,
        ctg: pesada.CTG ? String(pesada.CTG) : null,
        fechaInicioEstadoCTG: pesada.FechaInicioEstadoCTG || null,
        fechaVencimientoCTG: pesada.FechaVencimientoCTG || null,
        comentarioBalanza: comentario || null,
        ubicacionesFiltradas,
        source: 'pesada_query',
      },
    };

    return this.deliveryService.create(instanceName, createDto);
  }
}
