-- AlterTable: Add GPS fields to DeliveryLocation
ALTER TABLE "DeliveryLocation" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "DeliveryLocation" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "DeliveryLocation" ADD COLUMN IF NOT EXISTS "gpsTimestamp" TIMESTAMP;

-- AlterTable: Add messageType and actionData to DeliveryMessage
ALTER TABLE "DeliveryMessage" ADD COLUMN IF NOT EXISTS "messageType" VARCHAR(20) NOT NULL DEFAULT 'text';
ALTER TABLE "DeliveryMessage" ADD COLUMN IF NOT EXISTS "actionData" JSONB;
