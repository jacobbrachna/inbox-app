-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "aiPriorityAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "aiPriorityScore" INTEGER;
ALTER TABLE "Conversation" ADD COLUMN "aiPrioritySignal" TEXT;
