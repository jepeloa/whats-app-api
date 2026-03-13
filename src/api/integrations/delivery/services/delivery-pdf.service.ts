import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import PDFDocument from 'pdfkit';

import { Logger } from '../../../../config/logger.config';

interface DeliveryPdfData {
  idPesada: string;
  choferNombre: string;
  patente: string;
  artNombre: string;
  origen: string;
  pesoNeto: number;
  pesoUn: string;
  status: string;
  observaciones?: string | null;
  createdAt: Date;
  confirmedAt?: Date | null;
  locations: Array<{
    nombre: string;
    direccion: string;
    kilosDescargados?: number | null;
    notes?: string | null;
    status: string;
    deliveredAt?: Date | null;
    orden: number;
    latitude?: number | null;
    longitude?: number | null;
  }>;
}

export class DeliveryPdfService {
  private readonly logger = new Logger('DeliveryPdfService');

  /**
   * Generate a PDF report for a completed delivery
   * Returns the file path to the generated PDF
   */
  async generateDeliveryReport(delivery: DeliveryPdfData): Promise<string> {
    const fileName = `reporte_pesada_${delivery.idPesada}_${Date.now()}.pdf`;
    const filePath = path.join(os.tmpdir(), fileName);

    // Download map image if locations have GPS
    let mapImagePath: string | null = null;
    try {
      mapImagePath = await this.downloadMapImage(delivery.locations);
    } catch (err) {
      this.logger.warn(`Could not generate map image: ${err.message}`);
    }

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        // Header
        this.addHeader(doc, delivery);

        // Delivery Info Table
        this.addDeliveryInfo(doc, delivery);

        // Locations Table
        this.addLocationsTable(doc, delivery);

        // Summary
        this.addSummary(doc, delivery);

        // Mini Map
        if (mapImagePath) {
          this.addMap(doc, delivery, mapImagePath);
        }

        // Observations
        if (delivery.observaciones) {
          this.addObservations(doc, delivery.observaciones);
        }

        // Footer
        this.addFooter(doc);

        doc.end();

        stream.on('finish', () => {
          this.logger.info(`PDF generated: ${filePath}`);
          // Cleanup map image
          if (mapImagePath && fs.existsSync(mapImagePath)) {
            fs.unlinkSync(mapImagePath);
          }
          resolve(filePath);
        });

        stream.on('error', (error) => {
          this.logger.error(`Error generating PDF: ${error.message}`);
          if (mapImagePath && fs.existsSync(mapImagePath)) {
            fs.unlinkSync(mapImagePath);
          }
          reject(error);
        });
      } catch (error) {
        this.logger.error(`Error creating PDF: ${error.message}`);
        if (mapImagePath && fs.existsSync(mapImagePath)) {
          fs.unlinkSync(mapImagePath);
        }
        reject(error);
      }
    });
  }

  private addHeader(doc: PDFKit.PDFDocument, delivery: DeliveryPdfData) {
    doc.fontSize(20).font('Helvetica-Bold').text('REPORTE DE ENTREGA', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(14).font('Helvetica').text(`Pesada #${delivery.idPesada}`, { align: 'center' });
    doc.moveDown(0.3);

    const statusText = this.getStatusText(delivery.status);
    const statusColor = delivery.status === 'completed' ? '#28a745' : '#dc3545';
    doc.fontSize(12).fillColor(statusColor).text(`Estado: ${statusText}`, { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1);

    // Line separator
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);
  }

  private addDeliveryInfo(doc: PDFKit.PDFDocument, delivery: DeliveryPdfData) {
    doc.fontSize(14).font('Helvetica-Bold').text('INFORMACIÓN DEL VIAJE');
    doc.moveDown(0.5);

    const tableData = [
      ['Chofer:', delivery.choferNombre],
      ['Patente:', delivery.patente],
      ['Producto:', delivery.artNombre],
      ['Origen:', delivery.origen],
      ['Peso Cargado:', `${delivery.pesoNeto.toLocaleString('es-AR')} ${delivery.pesoUn}`],
      ['Fecha Inicio:', this.formatDate(delivery.createdAt)],
      ['Fecha Fin:', delivery.confirmedAt ? this.formatDate(delivery.confirmedAt) : 'En progreso'],
    ];

    const startY = doc.y;
    const col1X = 50;
    const col2X = 180;

    doc.font('Helvetica').fontSize(11);

    tableData.forEach((row, index) => {
      const y = startY + index * 20;
      doc.font('Helvetica-Bold').text(row[0], col1X, y);
      doc.font('Helvetica').text(row[1], col2X, y);
    });

    doc.y = startY + tableData.length * 20 + 20;
    doc.moveDown(1);
  }

  private addLocationsTable(doc: PDFKit.PDFDocument, delivery: DeliveryPdfData) {
    doc.fontSize(14).font('Helvetica-Bold').text('DETALLE DE DESCARGAS');
    doc.moveDown(0.5);

    // Table header
    const tableTop = doc.y;
    const colWidths = [30, 150, 100, 80, 100];
    const headers = ['#', 'Ubicación', 'Kilos', 'Estado', 'Hora'];

    // Header background
    doc.rect(50, tableTop, 495, 20).fill('#f0f0f0');
    doc.fillColor('#000000');

    // Header text
    doc.font('Helvetica-Bold').fontSize(10);
    let xPos = 55;
    headers.forEach((header, i) => {
      doc.text(header, xPos, tableTop + 5, { width: colWidths[i], align: 'left' });
      xPos += colWidths[i];
    });

    // Table rows
    doc.font('Helvetica').fontSize(10);
    let rowY = tableTop + 25;

    const sortedLocations = [...delivery.locations].sort((a, b) => a.orden - b.orden);

    sortedLocations.forEach((location, index) => {
      // Check for page break
      if (rowY > 700) {
        doc.addPage();
        rowY = 50;
      }

      // Alternate row background
      if (index % 2 === 0) {
        doc.rect(50, rowY - 3, 495, 20).fill('#fafafa');
        doc.fillColor('#000000');
      }

      xPos = 55;
      const rowData = [
        `${index + 1}`,
        location.nombre,
        location.kilosDescargados ? `${location.kilosDescargados.toLocaleString('es-AR')} kg` : '-',
        location.status === 'delivered' ? '✓ Entregado' : '○ Pendiente',
        location.deliveredAt ? this.formatTime(location.deliveredAt) : '-',
      ];

      rowData.forEach((cell, i) => {
        doc.text(cell, xPos, rowY, { width: colWidths[i], align: 'left' });
        xPos += colWidths[i];
      });

      // Notes
      if (location.notes) {
        rowY += 15;
        doc.fontSize(9).fillColor('#666666');
        doc.text(`   Nota: ${location.notes}`, 55, rowY, { width: 490 });
        doc.fillColor('#000000').fontSize(10);
      }

      rowY += 20;
    });

    doc.y = rowY + 10;
    doc.moveDown(1);
  }

  private addSummary(doc: PDFKit.PDFDocument, delivery: DeliveryPdfData) {
    const totalDescargado = delivery.locations
      .filter((l) => l.status === 'delivered' && l.kilosDescargados)
      .reduce((sum, l) => sum + (l.kilosDescargados || 0), 0);

    const diferencia = delivery.pesoNeto - totalDescargado;

    // Summary box
    doc.rect(50, doc.y, 495, 70).stroke();

    const boxY = doc.y + 10;
    doc.fontSize(12).font('Helvetica-Bold').text('RESUMEN', 60, boxY);

    doc.fontSize(11).font('Helvetica');
    doc.text(`Peso Cargado: ${delivery.pesoNeto.toLocaleString('es-AR')} kg`, 60, boxY + 20);
    doc.text(`Total Descargado: ${totalDescargado.toLocaleString('es-AR')} kg`, 60, boxY + 35);

    if (diferencia !== 0) {
      const difColor = diferencia > 0 ? '#dc3545' : '#28a745';
      const difText = diferencia > 0 ? 'Faltante' : 'Excedente';
      doc.fillColor(difColor).text(`${difText}: ${Math.abs(diferencia).toLocaleString('es-AR')} kg`, 60, boxY + 50);
      doc.fillColor('#000000');
    } else {
      doc.fillColor('#28a745').text('✓ Peso completo - Sin diferencias', 60, boxY + 50);
      doc.fillColor('#000000');
    }

    doc.y = doc.y + 80;
    doc.moveDown(1);
  }

  private addObservations(doc: PDFKit.PDFDocument, observaciones: string) {
    doc.fontSize(12).font('Helvetica-Bold').text('OBSERVACIONES');
    doc.moveDown(0.3);

    doc.rect(50, doc.y, 495, 60).stroke();
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(observaciones, 55, doc.y + 5, { width: 485 });

    doc.y = doc.y + 70;
  }

  private addFooter(doc: PDFKit.PDFDocument) {
    const bottomY = 780;

    doc
      .moveTo(50, bottomY - 20)
      .lineTo(545, bottomY - 20)
      .stroke();

    doc.fontSize(8).font('Helvetica').fillColor('#666666');
    doc.text(`Documento generado automáticamente - ${this.formatDate(new Date())}`, 50, bottomY - 10, {
      align: 'center',
    });
    doc.text('Sistema de Tracking de Entregas - La Sibila', 50, bottomY, { align: 'center' });
  }

  private getStatusText(status: string): string {
    const statusMap: Record<string, string> = {
      pending: 'Pendiente',
      in_progress: 'En Progreso',
      completed: 'Completado',
      partial: 'Parcial',
      not_delivered: 'No Entregado',
    };
    return statusMap[status] || status;
  }

  private formatDate(date: Date): string {
    return new Date(date).toLocaleString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Add map section to PDF showing GPS locations of deliveries
   */
  private addMap(doc: PDFKit.PDFDocument, delivery: DeliveryPdfData, mapImagePath: string) {
    // Check if we need a new page
    if (doc.y > 500) {
      doc.addPage();
    }

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000000').text('MAPA DE ENTREGAS');
    doc.moveDown(0.5);

    try {
      // Insert the map image
      doc.image(mapImagePath, 50, doc.y, { width: 495, height: 280 });
      doc.y += 290;

      // Add legend
      doc.fontSize(9).font('Helvetica').fillColor('#666666');
      const gpsLocations = delivery.locations.filter((l) => l.latitude && l.longitude);
      gpsLocations
        .sort((a, b) => a.orden - b.orden)
        .forEach((loc, i) => {
          doc.text(
            `📍 ${i + 1}. ${loc.nombre} (${loc.latitude?.toFixed(4)}, ${loc.longitude?.toFixed(4)})`,
            55,
            doc.y,
            {
              width: 490,
            },
          );
        });
      doc.fillColor('#000000');
      doc.moveDown(1);
    } catch (err) {
      this.logger.warn(`Could not embed map image in PDF: ${err.message}`);
    }
  }

  /**
   * Download a static map image for locations with GPS coordinates
   * Uses OpenStreetMap static map service (free, no API key)
   */
  private async downloadMapImage(locations: DeliveryPdfData['locations']): Promise<string | null> {
    const gpsLocations = locations.filter((l) => l.latitude && l.longitude && l.status === 'delivered');

    if (gpsLocations.length === 0) {
      return null;
    }

    // Calculate center and zoom from coordinates
    const lats = gpsLocations.map((l) => l.latitude!);
    const lngs = gpsLocations.map((l) => l.longitude!);
    const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;

    // Estimate zoom level based on coordinate spread
    const latSpread = Math.max(...lats) - Math.min(...lats);
    const lngSpread = Math.max(...lngs) - Math.min(...lngs);
    const maxSpread = Math.max(latSpread, lngSpread);
    let zoom = 12;
    if (maxSpread > 5) zoom = 6;
    else if (maxSpread > 2) zoom = 7;
    else if (maxSpread > 1) zoom = 8;
    else if (maxSpread > 0.5) zoom = 9;
    else if (maxSpread > 0.2) zoom = 10;
    else if (maxSpread > 0.1) zoom = 11;
    else if (maxSpread > 0.05) zoom = 12;
    else zoom = 13;

    // Use staticmap.openstreetmap.de (free OSM static maps)
    const markerParams = gpsLocations
      .sort((a, b) => a.orden - b.orden)
      .map((loc) => `markers=${loc.latitude},${loc.longitude},ol-marker`)
      .join('&');

    const url = `https://staticmap.openstreetmap.de/staticmap.php?center=${centerLat},${centerLng}&zoom=${zoom}&size=800x400&maptype=mapnik&${markerParams}`;

    const mapPath = path.join(os.tmpdir(), `map_${Date.now()}.png`);

    return new Promise((resolve) => {
      const request = https.get(url, { timeout: 10000 }, (response) => {
        // Handle redirects
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          const redirectUrl = response.headers.location;
          const protocol = redirectUrl.startsWith('https') ? https : http;
          protocol
            .get(redirectUrl, { timeout: 10000 }, (redirectRes) => {
              if (redirectRes.statusCode !== 200) {
                this.logger.warn(`Map redirect failed with status ${redirectRes.statusCode}`);
                resolve(null);
                return;
              }
              const file = fs.createWriteStream(mapPath);
              redirectRes.pipe(file);
              file.on('finish', () => {
                file.close();
                resolve(mapPath);
              });
              file.on('error', () => resolve(null));
            })
            .on('error', () => resolve(null));
          return;
        }

        if (response.statusCode !== 200) {
          this.logger.warn(`Map download failed with status ${response.statusCode}`);
          resolve(null);
          return;
        }

        const file = fs.createWriteStream(mapPath);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(mapPath);
        });
        file.on('error', () => resolve(null));
      });

      request.on('error', (err) => {
        this.logger.warn(`Map download error: ${err.message}`);
        resolve(null);
      });

      request.on('timeout', () => {
        request.destroy();
        resolve(null);
      });
    });
  }

  /**
   * Clean up generated PDF file
   */
  async cleanupPdf(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this.logger.info(`PDF cleaned up: ${filePath}`);
      }
    } catch (error) {
      this.logger.error(`Error cleaning up PDF: ${error.message}`);
    }
  }
}
