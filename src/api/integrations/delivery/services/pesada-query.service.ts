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
  Deposito: string;
  Destino: string;
  PesoNeto: number;
  TelefonoChofer: string;
  RUCADestino: number;
  Comprador: string;
  Transportista: string;
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
        'SELECT TOP 1 IdPesada, Chofer, Patente, Acoplado, Articulo, Deposito, Destino, PesoNeto, TelefonoChofer, RUCADestino, Comprador, Transportista FROM [vistas].[vwPesadasDeSalida] WHERE IdPesada = @idPesada',
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
