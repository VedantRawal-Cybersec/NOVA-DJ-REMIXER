import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "source-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function restore(entry) {
  if (!entry || !Array.isArray(entry.chunks) || !entry.chunks.length) {
    throw new Error("Invalid source manifest entry");
  }
  const output = path.resolve(root, entry.output);
  if (!output.startsWith(root + path.sep)) throw new Error("Unsafe output path");
  const parts = entry.chunks.map((relativePath) => {
    const input = path.resolve(root, relativePath);
    if (!input.startsWith(root + path.sep)) throw new Error("Unsafe source path");
    if (!fs.existsSync(input)) throw new Error(`Missing source chunk: ${relativePath}`);
    return brotliDecompressSync(fs.readFileSync(input));
  });
  const restored = Buffer.concat(parts);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, restored);
  return { output: path.relative(root, output), bytes: restored.length };
}

const site = restore(manifest.site);
const engine = restore(manifest.engine);
const html = fs.readFileSync(path.join(root, site.output), "utf8");
const js = fs.readFileSync(path.join(root, engine.output), "utf8");
if (!/<!doctype html/i.test(html.slice(0, 300))) throw new Error("Restored homepage does not look like an HTML document");
if (!js.includes("NOV") && !js.includes("audio")) throw new Error("Restored audio engine failed sanity check");
console.log("NOVA source restored successfully:");
console.log(`- ${site.output}: ${site.bytes.toLocaleString()} bytes`);
console.log(`- ${engine.output}: ${engine.bytes.toLocaleString()} bytes`);
