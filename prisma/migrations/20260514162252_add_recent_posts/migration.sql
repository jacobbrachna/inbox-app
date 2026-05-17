-- Add recent posts capture to Contact. Stale-by-design — refreshed on each
-- profile enrich.

ALTER TABLE "Contact" ADD COLUMN "recentPosts"   TEXT;
ALTER TABLE "Contact" ADD COLUMN "recentPostsAt" DATETIME;
