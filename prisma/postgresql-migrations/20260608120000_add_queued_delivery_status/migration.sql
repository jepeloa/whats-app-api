-- AlterEnum
-- Add 'queued' status so extra pesadas for a busy driver can be enqueued
-- instead of being rejected/lost (e.g. tolva dividida or múltiples viajes).
ALTER TYPE "DeliveryStatus" ADD VALUE IF NOT EXISTS 'queued';
