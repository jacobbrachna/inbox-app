import fs from 'node:fs';
import path from 'node:path';

// Local media store for downloaded message attachments (images, files, audio,
// video). The bytes themselves live on disk next to the SQLite DB so they
// survive the signed-URL expiry on LinkedIn's side; the DB only stores the
// filename in MessageAttachment.localPath.
//
// Dir resolution mirrors src/lib/db.ts: derive from DATABASE_URL's file path.
//   dev (next dev)   DATABASE_URL=file:./dev.db          → <repo>/media
//   packaged (electron) DATABASE_URL=file:<userData>/dev.db → <userData>/media
// Same logic works in both the Next dev server and the bundled electron handler.

let _dir: string | null = null;

export function getMediaDir(): string {
  if (_dir) return _dir;
  const dbUrl = process.env.DATABASE_URL ?? 'file:./dev.db';
  const dbPath = dbUrl.replace(/^file:/, '');
  _dir = path.join(path.dirname(path.resolve(dbPath)), 'media');
  try { fs.mkdirSync(_dir, { recursive: true }); } catch { /* best effort */ }
  return _dir;
}

// Resolve a stored filename to an absolute path, rejecting anything that isn't
// a plain basename (path-traversal guard — filenames must never contain a
// separator or `..`).
export function mediaFilePath(filename: string): string | null {
  if (!filename || filename !== path.basename(filename) || filename.includes('..')) {
    return null;
  }
  return path.join(getMediaDir(), filename);
}

export function saveMedia(filename: string, buf: Buffer): boolean {
  const fp = mediaFilePath(filename);
  if (!fp) return false;
  try { fs.writeFileSync(fp, buf); return true; } catch { return false; }
}

export function readMedia(filename: string): Buffer | null {
  const fp = mediaFilePath(filename);
  if (!fp || !fs.existsSync(fp)) return null;
  try { return fs.readFileSync(fp); } catch { return null; }
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

export function extFor(mediaType?: string, name?: string): string {
  if (name) {
    const e = path.extname(name);
    if (e && e.length <= 6) return e.toLowerCase();
  }
  if (mediaType && EXT_BY_MIME[mediaType]) return EXT_BY_MIME[mediaType];
  return '';
}

// Build a deterministic, collision-safe filename for an attachment so repeat
// ingests of the same item overwrite rather than duplicate.
export function mediaFilename(messageId: string, index: number, mediaType?: string, name?: string): string {
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return `${safeId}__${index}${extFor(mediaType, name)}`;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

export function contentTypeForFile(filename: string): string {
  return CONTENT_TYPE_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
