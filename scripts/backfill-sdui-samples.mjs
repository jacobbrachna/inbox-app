// Re-run the SDUI parser over already-captured samples in /tmp/inboxpro-sdui/
// and update matching Contacts. Useful when the parser gets fixed and we
// don't want to ask the user to re-trigger every profile.
//
// Mirrors the logic in /api/profile-sdui POST handler.

import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const dbUrl = (process.env.DATABASE_URL ?? 'file:./dev.db').replace(/^file:/, '');
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: dbUrl }) });

const DIR = '/tmp/inboxpro-sdui';

// Inline parser (mirrors src/lib/sdui-parse.ts)
const TEXT_RE = /"children":\["((?!\$)(?:[^"\\]|\\.){1,8000})"/g;
const DATE_RANGE_RE = /^([A-Z][a-z]+ \d{4}|\d{4})\s*[-–—]\s*(Present|[A-Z][a-z]+ \d{4}|\d{4})/;
const SKIP = /^(Show all|Experience|Education|Licenses|Certifications|Skills|Languages|Honors|Volunteer|See more|See less)\b/i;
const LOCATION = /\s·\s(On-site|Remote|Hybrid)$/i;

function unescape(s) { try { return JSON.parse(`"${s}"`); } catch { return s; } }
function extractTextLines(body) {
  const out = []; const seen = new Set();
  let m; TEXT_RE.lastIndex = 0;
  while ((m = TEXT_RE.exec(body)) !== null) {
    const raw = m[1]; if (!raw || raw.length < 2) continue;
    const t = unescape(raw);
    if (seen.has(t)) continue; seen.add(t); out.push(t);
  }
  return out;
}
function splitCompanyType(s) { const parts = s.split(/\s*[·•]\s*/); return { company: parts[0].trim(), type: parts[1]?.trim() ?? null }; }
function parseDateLine(s) {
  const m = s.match(DATE_RANGE_RE); if (!m) return null;
  const to = m[2].toLowerCase() === 'present' ? null : m[2];
  return { from: m[1], to };
}
function collectEntries(lines) {
  const out = [];
  const dateIndices = [];
  for (let i = 0; i < lines.length; i++) if (DATE_RANGE_RE.test(lines[i].trim())) dateIndices.push(i);
  for (const dIdx of dateIndices) {
    const dates = parseDateLine(lines[dIdx].trim()); if (!dates) continue;
    const back = [];
    for (let j = dIdx - 1; j >= 0 && back.length < 2; j--) {
      const l = lines[j].trim();
      if (!l) continue;
      if (SKIP.test(l)) continue;
      if (DATE_RANGE_RE.test(l)) break;
      if (/^Credential ID/i.test(l)) continue;
      if (/^Issued /i.test(l)) continue;
      if (LOCATION.test(l)) continue;
      if (/^[A-Z][^·]+,[^·]+(,[^·]+)?$/.test(l) && !/(present|inc|llc|ltd|university|college|institute)/i.test(l)) continue;
      back.unshift(l);
    }
    if (back.length === 0) continue;
    out.push({ first: back[0], second: back[1] ?? null, dates });
  }
  return out;
}
function parseSdui(componentId, body) {
  const lines = extractTextLines(body);
  const shortCid = componentId.split('.').slice(-1)[0];
  const out = {};
  if (shortCid === 'profileCardsAboveActivity') {
    const candidates = lines.filter((l) => l.length >= 60 && l.split(' ').length >= 8 && !/^\d/.test(l) && !/followers?$/i.test(l));
    if (candidates.length > 0) {
      out.about = candidates.reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 4000);
    }
    const skillsIdx = lines.findIndex((l) => l.trim() === 'Top skills');
    if (skillsIdx >= 0) for (let i = skillsIdx + 1; i < Math.min(lines.length, skillsIdx + 5); i++) {
      const c = lines[i];
      if (/[•·]/.test(c)) { out.skills = c.split(/\s*[•·]\s*/).map((s) => s.trim()).filter((s) => s.length > 0 && s.length < 80).slice(0, 10); break; }
    }
    const keySigIdx = lines.findIndex((l) => l.trim() === 'Key signals');
    if (keySigIdx >= 0 && lines[keySigIdx + 1]) { const sig = lines[keySigIdx + 1].trim(); if (sig && sig.length < 200) out.jobChangeSignal = sig; }
  }
  if (shortCid.startsWith('profileCardsBelowActivityPart')) {
    const entries = collectEntries(lines);
    const jobs = []; const schools = [];
    for (const e of entries) {
      const merged = `${e.first} ${e.second ?? ''}`.toLowerCase();
      if (/\b(issued|credential id|expires)\b/.test(merged)) continue;
      const isJob = /\b(full-time|part-time|contract|internship|freelance|self-employed|apprenticeship)\b/.test(merged);
      const isSchool = /\b(university|college|institute|school|bachelor|master|phd|m\.s\.|b\.s\.|b\.tech|m\.tech|mba|degree|graduated)\b/.test(merged);
      if (isJob) jobs.push({ role: e.first, company: e.second ? splitCompanyType(e.second).company : null, from: e.dates?.from ?? null, to: e.dates?.to ?? null });
      else if (isSchool) schools.push({ school: e.first, degree: e.second, from: e.dates?.from ?? null, to: e.dates?.to ?? null });
    }
    if (jobs.length > 0) out.prevRoles = jobs.slice(0, 8);
    if (schools.length > 0) out.education = schools.slice(0, 5);
  }
  if (shortCid === 'profileCardsActivity') {
    const noPosts = lines.findIndex((l) => /has no recent posts/i.test(l));
    if (noPosts >= 0) out.recentPosts = [];
    else {
      const posts = [];
      for (const l of lines) {
        if (l.length < 40) continue;
        if (/^\d/.test(l)) continue;
        if (/followers$/i.test(l)) continue;
        if (l === 'Activity') continue;
        posts.push({ text: l.slice(0, 600), url: null, postedAt: null, kind: 'post' });
        if (posts.length >= 5) break;
      }
      if (posts.length > 0) out.recentPosts = posts;
    }
  }
  return out;
}

// Group files by profileSlug, parse each component, merge into Contact.
const files = await readdir(DIR);
const bySlug = new Map();
for (const f of files) {
  if (!f.endsWith('.json')) continue;
  const [slug, rest] = f.split('__');
  if (!slug || !rest) continue;
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(f);
}

let touched = 0;
for (const [slug, fileList] of bySlug) {
  const contact = await prisma.contact.findUnique({ where: { profileSlug: slug } });
  if (!contact) {
    console.log(`  ! no contact for ${slug}, skipping`);
    continue;
  }
  const merged = {};
  for (const f of fileList) {
    const cid = `com.linkedin.sdui.generated.profile.dsl.impl.${f.split('__')[1].replace('.json', '')}`;
    const body = await readFile(join(DIR, f), 'utf-8');
    const out = parseSdui(cid, body);
    Object.assign(merged, out);
  }
  const patch = {};
  if (typeof merged.about === 'string' && merged.about.length > 0) patch.about = merged.about;
  if (Array.isArray(merged.prevRoles) && merged.prevRoles.length > 0) patch.prevRoles = JSON.stringify(merged.prevRoles);
  if (Array.isArray(merged.education) && merged.education.length > 0) patch.education = JSON.stringify(merged.education);
  if (Array.isArray(merged.skills) && merged.skills.length > 0) patch.skills = JSON.stringify(merged.skills);
  if (Array.isArray(merged.recentPosts) && merged.recentPosts.length > 0) {
    patch.recentPosts = JSON.stringify(merged.recentPosts);
    patch.recentPostsAt = new Date();
  }
  if (Object.keys(patch).length > 0) {
    await prisma.contact.update({ where: { id: contact.id }, data: patch });
    console.log(`  ✓ ${contact.name}: ${Object.keys(patch).join(', ')}`);
    touched++;
  } else {
    console.log(`  - ${contact.name}: nothing extracted`);
  }
}
console.log(`\n✓ Updated ${touched} contacts from ${bySlug.size} sample sets`);
await prisma.$disconnect();
