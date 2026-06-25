-- Dismiss flag for the Tasks → New Connections list.
ALTER TABLE "Contact" ADD COLUMN "tasksDismissedAt" DATETIME;
