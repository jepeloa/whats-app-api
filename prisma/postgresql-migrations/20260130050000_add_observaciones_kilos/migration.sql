-- AlterTable
ALTER TABLE "DeliveryTracking" ADD COLUMN IF NOT EXISTS "observaciones" TEXT;

-- AlterTable
ALTER TABLE "DeliveryLocation" ADD COLUMN IF NOT EXISTS "kilosDescargados" DOUBLE PRECISION;
