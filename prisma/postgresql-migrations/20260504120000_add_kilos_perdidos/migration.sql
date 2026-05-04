-- AlterTable: Add kilosPerdidos to DeliveryLocation
ALTER TABLE "DeliveryLocation" ADD COLUMN IF NOT EXISTS "kilosPerdidos" DOUBLE PRECISION;
