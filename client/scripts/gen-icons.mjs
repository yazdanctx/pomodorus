// Regenerates every icon asset from scripts/icon*.svg. Run: node scripts/gen-icons.mjs
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const squircle = await readFile(path.join(root, "scripts/icon.svg"));
const maskable = await readFile(path.join(root, "scripts/icon-maskable.svg"));

const png = (svg, size) => sharp(svg, { density: 300 }).resize(size, size).png().toBuffer();

// ICO container: ICONDIR + one ICONDIRENTRY per PNG-encoded image.
// Modern browsers all accept PNG-compressed ICO entries.
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const favSizes = [16, 32, 48];
const favs = await Promise.all(favSizes.map(async (s) => ({ size: s, data: await png(squircle, s) })));
await writeFile(path.join(root, "app/favicon.ico"), ico(favs));
await copyFile(path.join(root, "scripts/icon.svg"), path.join(root, "app/icon.svg"));
await writeFile(path.join(root, "app/apple-icon.png"), await png(maskable, 180));
await writeFile(path.join(root, "public/icon-192.png"), await png(squircle, 192));
await writeFile(path.join(root, "public/icon-512.png"), await png(squircle, 512));
await writeFile(path.join(root, "public/icon-maskable-512.png"), await png(maskable, 512));
console.log("icons regenerated");
