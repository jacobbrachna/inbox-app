// Shared Prisma client for backend handlers. Initialized once,
// reused across every /api/* request.

const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const path = require('path');
const { app } = require('electron');

const APP_ID = 'com.jacobbrachna.inboxpro';
const dbPath = path.join(app.getPath('appData'), APP_ID, 'dev.db');

let _prisma = null;
function prisma() {
  if (_prisma) return _prisma;
  _prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: dbPath }),
  });
  return _prisma;
}

module.exports = { prisma, dbPath };
