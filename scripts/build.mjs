import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateStudioDrumPack } from './generate-drum-pack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'public', 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

const copies = [
  {
    src: path.join(root, 'node_modules', 'signalsmith-stretch', 'SignalsmithStretch.mjs'),
    dest: path.join(vendorDir, 'signalsmith-stretch.mjs'),
  },
  {
    src: path.join(root, 'node_modules', 'essentia.js', 'dist', 'essentia.js-core.es.min.js'),
    dest: path.join(vendorDir, 'essentia.js-core.es.min.js'),
  },
  {
    src: path.join(root, 'node_modules', 'essentia.js', 'dist', 'essentia-wasm.es.js'),
    dest: path.join(vendorDir, 'essentia-wasm.es.js'),
  },
];

for (const item of copies) {
  if (!fs.existsSync(item.src)) {
    throw new Error(`Missing dependency file: ${item.src}. Run npm install first.`);
  }
  fs.copyFileSync(item.src, item.dest);
  const sizeKb = (fs.statSync(item.dest).size / 1024).toFixed(1);
  console.log(`Synced ${path.relative(root, item.dest)} (${sizeKb} KB)`);
}

const indexHtml = path.join(root, 'public', 'index.html');
if (!fs.existsSync(indexHtml)) {
  throw new Error('Missing public/index.html');
}
const drumFiles = generateStudioDrumPack();
console.log(`Generated ${drumFiles.length} royalty-free studio percussion samples in public/samples/.`);
console.log('NOVA AI DJ v2 build completed successfully.');
