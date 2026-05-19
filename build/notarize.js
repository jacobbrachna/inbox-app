// electron-builder's afterSign hook: submit the signed .app to Apple's
// notarytool. Skips silently if APPLE_ID is not set so local iteration
// builds don't have to wait 5-15 min per cycle.

const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (!process.env.APPLE_ID) {
    console.log('  (APPLE_ID not set — skipping notarization)');
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`  Notarizing ${appPath} — this takes 5-15 min`);
  await notarize({
    tool: 'notarytool',
    appBundleId: 'com.jacobbrachna.relay',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
  console.log('  ✓ Notarized');
};
