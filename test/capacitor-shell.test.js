import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('M2 Capacitor Android shell and synced www/ web assets are present', () => {
  const capCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
  assert.equal(capCfg.appId, 'com.skat.sisfall');
  assert.equal(capCfg.webDir, 'www');

  const required = [
    'www/index.html',
    'www/app.js',
    'www/styles.css',
    'www/core/agent.js',
    'www/sources/devicemotion.js',
    'android/app/build.gradle',
    'android/app/src/main/AndroidManifest.xml',
    'android/app/src/main/java/com/skat/sisfall/MainActivity.java',
    'android/app/src/main/assets/public/index.html',
    'android/app/src/main/assets/public/app.js',
  ];
  for (const rel of required) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing M2 shell file: ${rel}`);
  }

  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.match(gradle, /com\.skat\.sisfall/);
});
