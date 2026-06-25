-- Group-thread metadata on Conversation.
ALTER TABLE "Conversation" ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "memberCount" INTEGER;
ALTER TABLE "Conversation" ADD COLUMN "groupName" TEXT;
-- Parsed media/attachments (JSON) on Message.
ALTER TABLE "Message" ADD COLUMN "attachments" TEXT;
