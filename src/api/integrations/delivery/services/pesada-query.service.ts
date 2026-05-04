import { WAMonitoringService } from '@api/services/monitor.service';
import { ConfigService, SqlServer } from '@config/env.config';
import { Logger } from '@config/logger.config';
import * as sql from 'mssql';

export interface PesadaData {
  IdPesada: number;
  Chofer: string;
  Patente: string;
  Acoplado: string;
  Articulo: string;
  CodigoArticulo: string | null;
  Deposito: string;
  Destino: string;
  PesoNeto: number;
  PesoBruto: number | null;
  Tara: number | null;
  KM: number | null;
  TelefonoChofer: string;
  RUCADestino: number;
  Comprador: string;
  Transportista: string;
  CUITComprador: string | null;
  CUITChofer: string | null;
  CUITTransportista: string | null;
  NroPuntoVentaPesadaSalida: number | null;
  NroPesadaSalida: number | null;
  LetraPesadaSalida: string | null;
  TipoComprobante: string | null;
  CTG: string | number | null;
  FechaInicioEstadoCTG: Date | null;
  FechaVencimientoCTG: Date | null;
  Comentarios: string | null;
}

export interface UbicacionData {
  ub_id: string;
  ub_nombre: string;
  ub_latitud: number | null;
  ub_longitud: number | null;
}

export class PesadaQueryService {
  private readonly logger = new Logger('PesadaQueryService');
  private pesadasPool: sql.ConnectionPool | null = null;
  private sigoPool: sql.ConnectionPool | null = null;
  private readonly sqlConfig: SqlServer;

  constructor(
    private readonly configService: ConfigService,
    private readonly waMonitor: WAMonitoringService,
  ) {
    this.sqlConfig = this.configService.get<SqlServer>('SQLSERVER');
  }

  private async getPesadasPool(): Promise<sql.ConnectionPool> {
    if (this.pesadasPool?.connected) return this.pesadasPool;

    const config = this.sqlConfig.PESADAS;
    this.pesadasPool = new sql.ConnectionPool({
      server: config.HOST,
      port: config.PORT,
      user: config.USER,
      password: config.PASSWORD,
      database: config.DATABASE,
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 15000,
    });

    await this.pesadasPool.connect();
    this.logger.info('Connected to SQL Server (Pesadas)');
    return this.pesadasPool;
  }

  private async getSigoPool(): Promise<sql.ConnectionPool> {
    if (this.sigoPool?.connected) return this.sigoPool;

    const config = this.sqlConfig.SIGO;
    this.sigoPool = new sql.ConnectionPool({
      server: config.HOST,
      port: config.PORT,
      user: config.USER,
      password: config.PASSWORD,
      database: config.DATABASE,
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 15000,
    });

    await this.sigoPool.connect();
    this.logger.info('Connected to SQL Server (SIGO)');
    return this.sigoPool;
  }

  public async queryPesada(idPesada: number): Promise<PesadaData | null> {
    const pool = await this.getPesadasPool();
    const result = await pool
      .request()
      .input('idPesada', sql.Int, idPesada)
      .query(
        `SELECT TOP 1
            IdPesada, Chofer, Patente, Acoplado, Articulo, CodigoArticulo, Deposito, Destino,
            PesoNeto, PesoBruto, Tara, KM, TelefonoChofer, RUCADestino, Comprador, Transportista,
            CUITComprador, CUITChofer, CUITTransportista,
            NroPuntoVentaPesadaSalida, NroPesadaSalida, LetraPesadaSalida,
            TipoComprobante, CTG, FechaInicioEstadoCTG, FechaVencimientoCTG,
            CAST(Comentarios AS NVARCHAR(MAX)) AS Comentarios
          FROM [vistas].[vwPesadasDeSalida]
          WHERE IdPesada = @idPesada`,
      );

    if (result.recordset.length === 0) return null;
    return result.recordset[0];
  }

  public async queryUbicaciones(rucaDestino: number): Promise<UbicacionData[]> {
    const pool = await this.getSigoPool();
    const result = await pool
      .request()
      .input('rucaDestino', sql.VarChar(50), String(rucaDestino))
      .query('SELECT ub_id, ub_nombre, ub_latitud, ub_longitud FROM ubicaciones WHERE ub_ref = @rucaDestino');

    return result.recordset;
  }

  public formatPhoneNumber(telefonoChofer: string): string {
    const cleaned = telefonoChofer.replace(/\D/g, '').trim();
    if (cleaned.startsWith('549')) return cleaned;
    if (cleaned.startsWith('54')) return '549' + cleaned.substring(2);
    return '549' + cleaned;
  }

  public buildNotificationMessage(pesada: PesadaData, ubicaciones: UbicacionData[]): string {
    let message =
      `Hola ${pesada.Chofer.trim()}! registramos en nuestro sistema el traslado con el camión domino ` +
      `${pesada.Patente.trim()} del producto ${pesada.Articulo.trim()} desde ${pesada.Deposito.trim()} ` +
      `a ${pesada.Destino.trim()} por ${pesada.PesoNeto} KG. ¿Podrás confirmarnos la descarga?`;

    if (ubicaciones.length > 0) {
      const ubicacionesList = ubicaciones.map((u, i) => `${i + 1}. ${u.ub_nombre}`).join('\n');
      message += `\n\nUbicaciones de descarga:\n${ubicacionesList}`;
    }

    return message;
  }

  // ==================== SIGO Write Methods ====================

  /**
   * Find the traslado record in SIGO by external ID (IdPesada)
   * Returns the most recent match (highest tras_id)
   */
  public async findTraslado(idPesada: string): Promise<{ tras_id: number; tras_ext_id: string; tras_estado: string } | null> {
    try {
      const pool = await this.getSigoPool();
      const result = await pool
        .request()
        .input('extId', sql.NVarChar(50), idPesada)
        .query('SELECT TOP 1 tras_id, tras_ext_id, tras_estado FROM traslado WHERE tras_ext_id = @extId ORDER BY tras_id DESC');

      if (result.recordset.length === 0) return null;
      return result.recordset[0];
    } catch (error) {
      this.logger.error(`Error finding traslado for pesada ${idPesada}: ${error.message}`);
      return null;
    }
  }

  /**
   * Find or create traslado record in SIGO (idempotent upsert).
   * If it exists, UPDATEs all fields (preserving tras_estado/tras_dt_cierre).
   * If not, creates it from delivery data.
   */
  public async findOrCreateTraslado(delivery: any): Promise<{ tras_id: number; tras_ext_id: string; tras_estado: string } | null> {
    try {
      const pool = await this.getSigoPool();
      const metadata = delivery.metadata || {};
      const choferTel = delivery.remoteJid?.replace('@s.whatsapp.net', '') || '';

      const toDate = (v: any): Date | null => {
        if (!v) return null;
        const d = v instanceof Date ? v : new Date(v);
        return isNaN(d.getTime()) ? null : d;
      };
      const toNum = (v: any): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return isNaN(n) ? null : n;
      };
      const toStr = (v: any, max?: number): string | null => {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === '') return null;
        return max ? s.substring(0, max) : s;
      };

      // Bind all common params on a single request (used for both INSERT and UPDATE)
      const buildRequest = () => pool
        .request()
        .input('extId', sql.NVarChar(50), delivery.idPesada)
        .input('extNombre', sql.Char(3), 'SOL')
        .input('dt', sql.DateTime, delivery.createdAt || new Date())
        .input('compCuit', sql.NVarChar(50), toStr(metadata.cuitComprador, 50))
        .input('compNombre', sql.NVarChar(250), metadata.comprador || null)
        .input('origen', sql.NVarChar(250), delivery.origen || null)
        .input('destino', sql.NVarChar(250), metadata.destino || null)
        .input('choferCuit', sql.NVarChar(50), toStr(metadata.cuitChofer, 50))
        .input('choferNombre', sql.NVarChar(250), delivery.choferNombre || null)
        .input('choferTel', sql.NVarChar(50), choferTel || null)
        .input('trCuit', sql.NVarChar(50), toStr(metadata.cuitTransportista, 50))
        .input('trNombre', sql.NVarChar(250), metadata.transportista || null)
        .input('tara', sql.Decimal(18, 2), toNum(metadata.tara))
        .input('bruto', sql.Decimal(18, 2), toNum(metadata.pesoBruto))
        .input('neto', sql.Decimal(18, 2), delivery.pesoNeto || 0)
        .input('pesoUn', sql.Char(2), (delivery.pesoUn || 'KG').substring(0, 2))
        .input('patente1', sql.NVarChar(20), delivery.patente || null)
        .input('patente2', sql.NVarChar(20), metadata.acoplado || null)
        .input('km', sql.Decimal(18, 2), toNum(metadata.km))
        .input('puntoVtaPes', sql.Int, toNum(metadata.nroPuntoVentaPesadaSalida))
        .input('compVtaPes', sql.Int, toNum(metadata.nroPesadaSalida))
        .input('compVtaLetra', sql.Char(1), toStr(metadata.letraPesadaSalida, 1))
        .input('codArt', sql.NVarChar(20), toStr(metadata.codigoArticulo, 20))
        .input('artNombre', sql.NVarChar(250), delivery.artNombre || null)
        .input('ctg', sql.NVarChar(50), toStr(metadata.ctg, 50))
        .input('dtIniCtg', sql.DateTime, toDate(metadata.fechaInicioEstadoCTG))
        .input('dtFinCtg', sql.DateTime, toDate(metadata.fechaVencimientoCTG))
        .input('tipoComp', sql.NVarChar(10), toStr(metadata.tipoComprobante, 10))
        .input('compRuca', sql.NVarChar(50), metadata.rucaDestino ? String(metadata.rucaDestino) : null)
        .input('obs', sql.NVarChar(250), toStr(metadata.comentarioBalanza, 250));

      const existing = await this.findTraslado(delivery.idPesada);
      if (existing) {
        this.logger.info(`Updating traslado ${existing.tras_id} in SIGO for pesada ${delivery.idPesada}`);
        await buildRequest()
          .input('trasId', sql.Int, existing.tras_id)
          .query(
            `UPDATE traslado SET
                tras_ext_nombre = @extNombre,
                tras_dt = @dt,
                tras_comp_cuit = @compCuit,
                tras_comp_nombre = @compNombre,
                tras_origen = @origen,
                tras_destino = @destino,
                tras_chofer_cuit = @choferCuit,
                tras_chofer_nombre = @choferNombre,
                tras_chofer_tel = @choferTel,
                tras_tr_cuit = @trCuit,
                tras_tr_nombre = @trNombre,
                tras_tara = @tara,
                tras_bruto = @bruto,
                tras_neto = @neto,
                tras_peso_un = @pesoUn,
                tras_patente_1 = @patente1,
                tras_patente_2 = @patente2,
                tras_km = @km,
                tras_punto_vta_pes = @puntoVtaPes,
                tras_comp_vta_pes = @compVtaPes,
                tras_comp_vta_letra = @compVtaLetra,
                tras_cod_art = @codArt,
                tras_art_nombre = @artNombre,
                tras_ctg = @ctg,
                tras_dt_ini_ctg = @dtIniCtg,
                tras_dt_fin_ctg = @dtFinCtg,
                tras_tipo_comp = @tipoComp,
                tras_comp_ruca = @compRuca,
                tras_obs = @obs
              WHERE tras_id = @trasId`,
          );
        return existing;
      }

      this.logger.info(`Creating traslado in SIGO for pesada ${delivery.idPesada}`);
      const result = await buildRequest()
        .input('estado', sql.NVarChar(50), 'pendiente')
        .query(
          `INSERT INTO traslado (
              tras_ext_id, tras_ext_nombre, tras_dt,
              tras_comp_cuit, tras_comp_nombre, tras_origen, tras_destino,
              tras_chofer_cuit, tras_chofer_nombre, tras_chofer_tel,
              tras_tr_cuit, tras_tr_nombre,
              tras_tara, tras_bruto, tras_neto, tras_peso_un,
              tras_patente_1, tras_patente_2, tras_km,
              tras_punto_vta_pes, tras_comp_vta_pes, tras_comp_vta_letra,
              tras_cod_art, tras_art_nombre,
              tras_ctg, tras_dt_ini_ctg, tras_dt_fin_ctg,
              tras_tipo_comp, tras_comp_ruca, tras_obs, tras_estado)
           OUTPUT INSERTED.tras_id
           VALUES (
              @extId, @extNombre, @dt,
              @compCuit, @compNombre, @origen, @destino,
              @choferCuit, @choferNombre, @choferTel,
              @trCuit, @trNombre,
              @tara, @bruto, @neto, @pesoUn,
              @patente1, @patente2, @km,
              @puntoVtaPes, @compVtaPes, @compVtaLetra,
              @codArt, @artNombre,
              @ctg, @dtIniCtg, @dtFinCtg,
              @tipoComp, @compRuca, @obs, @estado)`,
        );

      const trasId = result.recordset[0].tras_id;
      this.logger.info(`Created traslado ${trasId} in SIGO for pesada ${delivery.idPesada}`);
      return { tras_id: trasId, tras_ext_id: delivery.idPesada, tras_estado: 'pendiente' };
    } catch (error) {
      this.logger.error(`Error upserting traslado for pesada ${delivery.idPesada}: ${error.message}`);
      return null;
    }
  }

  /**
   * Look up ub_id from ubicaciones table by name
   */
  public async findUbicacionIdByName(nombre: string): Promise<string | null> {
    try {
      const pool = await this.getSigoPool();
      const result = await pool
        .request()
        .input('nombre', sql.NVarChar(250), nombre)
        .query('SELECT TOP 1 ub_id FROM ubicaciones WHERE ub_nombre = @nombre');

      if (result.recordset.length === 0) return null;
      return result.recordset[0].ub_id;
    } catch (error) {
      this.logger.error(`Error finding ub_id for "${nombre}": ${error.message}`);
      return null;
    }
  }

  /**
   * Save delivery results to traslado_descarga (one row per location)
   * Deletes existing rows for this traslado first (idempotent on re-creation)
   */
  public async saveDescarga(
    trasId: number,
    extId: string,
    locations: Array<{ nombre: string; kilosDescargados: number | null; ubId?: string | null }>,
    pesoUn: string,
  ): Promise<void> {
    const pool = await this.getSigoPool();

    // Delete existing rows to avoid duplicates on pesada re-creation
    await pool
      .request()
      .input('trasId', sql.Int, trasId)
      .query('DELETE FROM traslado_descarga WHERE tras_id = @trasId');

    for (const loc of locations) {
      await pool
        .request()
        .input('trasId', sql.Int, trasId)
        .input('extId', sql.NVarChar(50), extId)
        .input('ubicId', sql.NVarChar(10), loc.ubId || null)
        .input('ubicNombre', sql.NVarChar(250), loc.nombre)
        .input('qty', sql.Decimal(18, 2), loc.kilosDescargados || 0)
        .input('qtyUn', sql.Char(2), pesoUn.substring(0, 2))
        .query(
          `INSERT INTO traslado_descarga (tras_id, tras_ext_id, tras_desc_ubic_id, tras_desc_ubic_nombre, tras_desc_qty, tras_desc_qty_un)
           VALUES (@trasId, @extId, @ubicId, @ubicNombre, @qty, @qtyUn)`,
        );
    }
  }

  /**
   * Log an event to traslado_bitacora
   */
  public async saveBitacora(trasId: number, evento: string, obs?: string): Promise<void> {
    const pool = await this.getSigoPool();
    await pool
      .request()
      .input('trasId', sql.Int, trasId)
      .input('dt', sql.DateTime, new Date())
      .input('evento', sql.NVarChar(50), evento)
      .input('obs', sql.NVarChar(250), obs ? obs.substring(0, 250) : null)
      .query(
        `INSERT INTO traslado_bitacora (tras_id, tras_bit_dt, tras_bit_evento, tras_bit_obs)
         VALUES (@trasId, @dt, @evento, @obs)`,
      );
  }

  /**
   * Update traslado status and close date
   */
  public async updateTrasladoEstado(trasId: number, estado: string): Promise<void> {
    const pool = await this.getSigoPool();
    await pool
      .request()
      .input('trasId', sql.Int, trasId)
      .input('estado', sql.NVarChar(50), estado)
      .input('dtCierre', sql.DateTime, new Date())
      .query('UPDATE traslado SET tras_estado = @estado, tras_dt_cierre = @dtCierre WHERE tras_id = @trasId');
  }

  /**
   * Save the WhatsApp conversation log to wsapp_log
   * Deletes existing rows for this traslado first (idempotent on re-creation)
   */
  public async saveWsappLog(trasId: number, choferTel: string, messages: any[]): Promise<void> {
    const pool = await this.getSigoPool();

    // Delete existing log to avoid duplicates on pesada re-creation
    await pool
      .request()
      .input('trasId', sql.Int, trasId)
      .query('DELETE FROM wsapp_log WHERE tras_id = @trasId');

    await pool
      .request()
      .input('trasId', sql.Int, trasId)
      .input('tel', sql.NVarChar(50), choferTel ? choferTel.substring(0, 50) : null)
      .input('json', sql.NVarChar(sql.MAX), JSON.stringify(messages))
      .query(
        `INSERT INTO wsapp_log (tras_id, tras_chofer_tel, wsapp_json)
         VALUES (@trasId, @tel, @json)`,
      );
  }

  // ==================== Legacy Methods ====================

  public async notifyPesada(instanceName: string, idPesada: number, testPhone?: string): Promise<any> {
    const pesada = await this.queryPesada(idPesada);
    if (!pesada) {
      throw new Error(`Pesada ${idPesada} no encontrada en SQL Server`);
    }

    const ubicaciones = await this.queryUbicaciones(pesada.RUCADestino);
    const message = this.buildNotificationMessage(pesada, ubicaciones);

    let phoneNumber: string;
    if (testPhone) {
      phoneNumber = testPhone;
    } else {
      if (!pesada.TelefonoChofer || pesada.TelefonoChofer.trim() === '') {
        throw new Error(`Pesada ${idPesada}: el chofer no tiene teléfono registrado`);
      }
      phoneNumber = this.formatPhoneNumber(pesada.TelefonoChofer);
    }

    const waInstance = this.waMonitor.waInstances[instanceName];
    if (!waInstance) {
      throw new Error(`WhatsApp instance ${instanceName} not found`);
    }

    await waInstance.textMessage(
      {
        number: phoneNumber,
        text: message,
      },
      false,
    );

    this.logger.info(`Notification sent for pesada ${idPesada} to ${phoneNumber} via instance ${instanceName}`);

    return {
      idPesada,
      phoneNumber,
      message,
      ubicaciones: ubicaciones.map((u) => u.ub_nombre),
      chofer: pesada.Chofer.trim(),
      patente: pesada.Patente.trim(),
    };
  }
}
