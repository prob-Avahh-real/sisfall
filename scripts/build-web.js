import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = path.join(ROOT, 'www');
const ANDROID_PUBLIC = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
const ANDROID_ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');

const ROOT_FILES = ['index.html', 'app.js', 'styles.css'];
const ROOT_DIRS = ['core', 'sources', 'models'];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function linkVendor(targetRoot) {
  const vendorSrc = path.join(ROOT, 'vendor');
  if (!fs.existsSync(vendorSrc)) return;
  const vendorDst = path.join(targetRoot, 'vendor');
  try {
    const st = fs.lstatSync(vendorDst);
    if (st.isSymbolicLink() || st.isFile()) fs.unlinkSync(vendorDst);
  } catch {
    /* does not exist yet */
  }
  if (!fs.existsSync(vendorDst)) {
    const rel = path.relative(targetRoot, vendorSrc);
    fs.symlinkSync(rel, vendorDst, 'dir');
  }
}

function syncWebRoot(dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ROOT_FILES) {
    fs.copyFileSync(path.join(ROOT, f), path.join(dst, f));
  }
  for (const d of ROOT_DIRS) {
    copyDir(path.join(ROOT, d), path.join(dst, d));
  }
  linkVendor(dst);
}

syncWebRoot(WWW);
if (fs.existsSync(path.join(ROOT, 'android'))) {
  syncWebRoot(ANDROID_PUBLIC);
  fs.mkdirSync(ANDROID_ASSETS, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'capacitor.config.json'),
    path.join(ANDROID_ASSETS, 'capacitor.config.json')
  );
}
console.log('✅ SisFall web assets synced to www/ and android/');
