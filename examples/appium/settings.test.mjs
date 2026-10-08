import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createSession } from './client.mjs';

const artifacts = process.env.RDF_ARTIFACTS_DIR || 'artifacts';

test('Android Settings over Remote Device Farm ADB', { timeout: 180_000 }, async (t) => {
  assert.ok(process.env.ANDROID_SERIAL, 'Run this test through scripts/rdf.sh run so ANDROID_SERIAL is set');
  const adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT || 5037);
  assert.ok(Number.isInteger(adbPort) && adbPort > 0 && adbPort <= 65535, 'Invalid ANDROID_ADB_SERVER_PORT');
  await mkdir(artifacts, { recursive: true });
  const driver = await createSession({
    port: Number(process.env.APPIUM_PORT || 4723),
    signal: t.signal,
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': process.env.ANDROID_SERIAL,
      'appium:adbPort': adbPort,
      'appium:appPackage': 'com.android.settings',
      'appium:appActivity': '.Settings',
      'appium:noReset': true,
      // This ADB server may also hold another developer's connections.
      'appium:suppressKillServer': true,
      'appium:newCommandTimeout': 60,
    },
  });
  t.after(async () => { await driver.deleteSession(); });
  try {
    await driver.waitForDisplayed('new UiSelector().textMatches("(?i)Network.*internet|Сеть.*интернет")', { timeout: 20_000 });
    await driver.saveScreenshot(path.join(artifacts, 'settings-home.png'));
  } catch (error) {
    await driver.saveScreenshot(path.join(artifacts, 'failure.png')).catch((captureError) => {
      t.diagnostic(`Could not save failure screenshot: ${captureError.message}`);
    });
    throw error;
  }
});
