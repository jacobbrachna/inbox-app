-- Denormalized flag: thread contains attachments.
ALTER TABLE "Conversation" ADD COLUMN "hasAttachments" BOOLEAN NOT NULL DEFAULT false;
