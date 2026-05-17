-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linkedinUrn" TEXT,
    "profileSlug" TEXT,
    "profileUrl" TEXT,
    "name" TEXT NOT NULL,
    "headline" TEXT,
    "avatarUrl" TEXT,
    "company" TEXT,
    "companyDomain" TEXT,
    "role" TEXT,
    "location" TEXT,
    "industry" TEXT,
    "tenure" TEXT,
    "source" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "enrichmentAt" DATETIME,
    "lastOutboundAt" DATETIME,
    "lastInboundAt" DATETIME,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "zoominfoData" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ConversationContact" (
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,

    PRIMARY KEY ("conversationId", "contactId"),
    CONSTRAINT "ConversationContact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_linkedinUrn_key" ON "Contact"("linkedinUrn");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_profileSlug_key" ON "Contact"("profileSlug");

-- CreateIndex
CREATE INDEX "Contact_lastOutboundAt_idx" ON "Contact"("lastOutboundAt");

-- CreateIndex
CREATE INDEX "Contact_lastSeenAt_idx" ON "Contact"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Contact_company_idx" ON "Contact"("company");

-- CreateIndex
CREATE INDEX "ConversationContact_contactId_idx" ON "ConversationContact"("contactId");
