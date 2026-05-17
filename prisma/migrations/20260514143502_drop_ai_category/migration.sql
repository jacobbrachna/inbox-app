-- Drop the deprecated aiCategory column. Classification surface is now the
-- AI-managed Label rows (multi-label, mutex groups, user-extensible).
-- The Conversation_aiCategory_idx index is also no longer needed.

PRAGMA foreign_keys=OFF;

DROP INDEX IF EXISTS "Conversation_aiCategory_idx";

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

INSERT INTO "new_Conversation" (
    "id","source","participants","lastMessage","lastMessageAt","unreadCount","status","isStarred",
    "snoozedUntil","followUpAt","followUpSource","followUpReason","followUpConfidence","needsReview",
    "notes","labels","rawData","aiSummary","aiUpdatedAt","aiPriorityScore","aiPrioritySignal","aiPriorityAt",
    "enrichment","enrichmentAt","createdAt","updatedAt"
)
SELECT
    "id","source","participants","lastMessage","lastMessageAt","unreadCount","status","isStarred",
    "snoozedUntil","followUpAt","followUpSource","followUpReason","followUpConfidence","needsReview",
    "notes","labels","rawData","aiSummary","aiUpdatedAt","aiPriorityScore","aiPrioritySignal","aiPriorityAt",
    "enrichment","enrichmentAt","createdAt","updatedAt"
FROM "Conversation";

DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";

CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");
CREATE INDEX "Conversation_followUpAt_idx" ON "Conversation"("followUpAt");

PRAGMA foreign_keys=ON;
