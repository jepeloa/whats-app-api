export class DeliveryLocationDto {
  nombre: string;
  direccion: string;
  orden?: number;
}

export class CreateDeliveryDto {
  idPesada: string;
  phoneNumber: string;
  choferNombre: string;
  patente: string;
  artNombre: string;
  origen: string;
  pesoNeto: number;
  pesoUn: string;
  ubicaciones: DeliveryLocationDto[];
  emailRecipients?: string[];
  metadata?: Record<string, any>;
}

export class DeliveryStatusDto {
  idPesada: string;
}

export class CloseDeliveryDto {
  idPesada: string;
  reason?: string;
}

export class DeliveryResponseDto {
  id: string;
  idPesada: string;
  remoteJid: string;
  choferNombre: string;
  patente: string;
  artNombre: string;
  origen: string;
  pesoNeto: number;
  pesoUn: string;
  status: string;
  reminderCount: number;
  locations: Array<{
    id: string;
    nombre: string;
    direccion: string;
    status: string;
    deliveredAt?: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export class NotifyPesadaDto {
  idPesada: number;
}

export class NotifyPesadaTestDto {
  idPesada: number;
  testPhone: string;
}
