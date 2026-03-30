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
