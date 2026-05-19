// electron-builder afterPack hook. Copies node_modules/.prisma/ into the
// packaged .app at app.asar.unpacked/node_modules/.prisma/ so that
// @prisma/client/default.js's `require('.prisma/client/default')` can
// resolve at runtime.
//
// electron-builder's normal file filter excludes the dot-prefixed
// .prisma directory (it walks package.json's dependencies, and .prisma
// is generated rather than declared). This hook bypasses that.

const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

exports.default = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const dest = path.join(
    appOutDir,
    `${appName}.app`,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    '.prisma',
  );
  const src = path.join(packager.projectDir, 'node_modules', '.prisma');
  if (!fs.existsSync(src)) {
    throw new Error(`Prisma generated client missing at ${src} — run 'prisma generate'`);
  }
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(src, dest);
  console.log(`  ✓ copied .prisma/ → ${path.relative(appOutDir, dest)}`);
};
