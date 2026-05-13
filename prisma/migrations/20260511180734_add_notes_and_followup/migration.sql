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
    "notes" TEXT NOT NULL DEFAULT '',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Conversation" ("createdAt", "id", "isStarred", "labels", "lastMessage", "lastMessageAt", "participants", "snoozedUntil", "source", "status", "unreadCount", "updatedAt") SELECT "createdAt", "id", "isStarred", "labels", "lastMessage", "lastMessageAt", "participants", "snoozedUntil", "source", "status", "unreadCount", "updatedAt" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");
CREATE INDEX "Conversation_status_idx" ON "Conversation"("status");
CREATE INDEX "Conversation_followUpAt_idx" ON "Conversation"("followUpAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
