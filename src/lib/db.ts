import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

// Prisma 7 requires a driver adapter — the classic query engine no longer
// reads the datasource URL from the schema at runtime. We use the
// better-sqlite3 adapter against the local file database.
const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: dbUrl }),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
