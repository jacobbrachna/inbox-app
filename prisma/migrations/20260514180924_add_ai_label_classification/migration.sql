-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL DEFAULT 'linkedin',
    "participants" TEXT NOT NULL,
    "lastMessage" TEXT NOT NULL DEFAULT '',
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'read',
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "snoozedUntil" DATETIME,
    "followUpAt" DATETIME,
    "followUpSource" TEXT,
    "followUpReason" TEXT,
    "followUpConfidence" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT NOT NULL DEFAULT '',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "rawData" TEXT,
    "aiCategory" TEXT,
    "aiSummary" TEXT,
    "aiUpdatedAt" DATETIME,
    "aiPriorityScore" INTEGER,
    "aiPrioritySignal" TEXT,
    "aiPriorityAt" DATETIME,
    "enrichment" TEXT,
    "enrichmentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Conversation" ("aiCategory", "aiPriorityAt", "aiPriorityScore", "aiPrioritySignal", "aiSummary", "aiUpdatedAt", "createdAt", "enrichment", "enrichmentAt", "followUpAt", "followUpConfidence", "followUpReason", "followUpSource", "id", "isStarred", "labels", "lastMessage", "lastMessageAt", "notes", "participants", "rawData", "snoozedUntil", "source", "status", "unreadCount", "updatedAt") SELECT "aiCategory", "aiPriorityAt", "aiPriorityScore", "aiPrioritySignal", "aiSummary", "aiUpdatedAt", "createdAt", "enrichment", "enrichmentAt", "followUpAt", "followUpConfidence", "followUpReason", "followUpSource", "id", "isStarred", "labels", "lastMessage", "lastMessageAt", "notes", "participants", "rawData", "snoozedUntil", "source", "status", "unreadCount", "updatedAt" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");
CREATE INDEX "Conversation_followUpAt_idx" ON "Conversation"("followUpAt");
CREATE INDEX "Conversation_aiCategory_idx" ON "Conversation"("aiCategory");
CREATE TABLE "new_Label" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "aiManaged" BOOLEAN NOT NULL DEFAULT false,
    "exclusiveGroup" TEXT
);
INSERT INTO "new_Label" ("color", "id", "name") SELECT "color", "id", "name" FROM "Label";
DROP TABLE "Label";
ALTER TABLE "new_Label" RENAME TO "Label";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
