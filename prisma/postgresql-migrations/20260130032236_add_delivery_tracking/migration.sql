-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'in_progress', 'partial', 'not_delivered', 'completed');

-- CreateEnum
CREATE TYPE "DeliveryLocationStatus" AS ENUM ('pending', 'delivered');

-- CreateTable
CREATE TABLE "DeliveryTracking" (
    "id" TEXT NOT NULL,
    "idPesada" VARCHAR(100) NOT NULL,
    "remoteJid" VARCHAR(100) NOT NULL,
    "choferNombre" VARCHAR(255) NOT NULL,
    "patente" VARCHAR(50) NOT NULL,
    "artNombre" VARCHAR(255) NOT NULL,
    "origen" VARCHAR(500) NOT NULL,
    "pesoNeto" DOUBLE PRECISION NOT NULL,
    "pesoUn" VARCHAR(20) NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP,
    "lastMessageAt" TIMESTAMP,
    "emailRecipients" VARCHAR(1000),
    "metadata" JSONB,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    "confirmedAt" TIMESTAMP,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "DeliveryTracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryLocation" (
    "id" TEXT NOT NULL,
    "nombre" VARCHAR(255) NOT NULL,
    "direccion" VARCHAR(500) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "status" "DeliveryLocationStatus" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    "deliveryTrackingId" TEXT NOT NULL,

    CONSTRAINT "DeliveryLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryMessage" (
    "id" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "content" TEXT NOT NULL,
    "timestamp" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveryTrackingId" TEXT NOT NULL,

    CONSTRAINT "DeliveryMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliveryTracking_instanceId_idx" ON "DeliveryTracking"("instanceId");

-- CreateIndex
CREATE INDEX "DeliveryTracking_remoteJid_instanceId_status_idx" ON "DeliveryTracking"("remoteJid", "instanceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTracking_idPesada_instanceId_key" ON "DeliveryTracking"("idPesada", "instanceId");

-- CreateIndex
CREATE INDEX "DeliveryLocation_deliveryTrackingId_idx" ON "DeliveryLocation"("deliveryTrackingId");

-- CreateIndex
CREATE INDEX "DeliveryMessage_deliveryTrackingId_idx" ON "DeliveryMessage"("deliveryTrackingId");

-- CreateIndex
CREATE INDEX "DeliveryMessage_timestamp_idx" ON "DeliveryMessage"("timestamp");

-- AddForeignKey
ALTER TABLE "DeliveryTracking" ADD CONSTRAINT "DeliveryTracking_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLocation" ADD CONSTRAINT "DeliveryLocation_deliveryTrackingId_fkey" FOREIGN KEY ("deliveryTrackingId") REFERENCES "DeliveryTracking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryMessage" ADD CONSTRAINT "DeliveryMessage_deliveryTrackingId_fkey" FOREIGN KEY ("deliveryTrackingId") REFERENCES "DeliveryTracking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
