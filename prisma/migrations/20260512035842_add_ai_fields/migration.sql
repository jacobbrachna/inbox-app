-- AlterTable
ALTER TABLE "AppState" ADD COLUMN "aiStyleNote" TEXT;
ALTER TABLE "AppState" ADD COLUMN "anthropicApiKey" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "aiCategory" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "aiSummary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "aiUpdatedAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "enrichment" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "enrichmentAt" DATETIME;

-- CreateIndex
CREATE INDEX "Conversation_aiCategory_idx" ON "Conversation"("aiCategory");
