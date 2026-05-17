-- Phase 2 schema additions:
--   • ContactSnapshot table for job-change history
--   • Outcome fields on Message (gotReply, replyAt, daysToReply)
--   • Expanded Contact fields (about, prevRoles, education, postsCount)

CREATE TABLE "ContactSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "company" TEXT,
    "companyDomain" TEXT,
    "role" TEXT,
    "headline" TEXT,
    "source" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactSnapshot_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ContactSnapshot_contactId_capturedAt_idx" ON "ContactSnapshot"("contactId", "capturedAt");
CREATE INDEX "ContactSnapshot_capturedAt_idx" ON "ContactSnapshot"("capturedAt");

ALTER TABLE "Contact" ADD COLUMN "about"      TEXT;
ALTER TABLE "Contact" ADD COLUMN "prevRoles"  TEXT;
ALTER TABLE "Contact" ADD COLUMN "education"  TEXT;
ALTER TABLE "Contact" ADD COLUMN "postsCount" INTEGER;

ALTER TABLE "Message" ADD COLUMN "gotReply"    BOOLEAN  NOT NULL DEFAULT false;
ALTER TABLE "Message" ADD COLUMN "replyAt"     DATETIME;
ALTER TABLE "Message" ADD COLUMN "daysToReply" INTEGER;

CREATE INDEX "Message_isFromMe_gotReply_idx" ON "Message"("isFromMe", "gotReply");
