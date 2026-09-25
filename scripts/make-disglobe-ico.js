/* Generate build/disglobe.ico — a teal globe on transparent background.
   ICO with a single 256x256 PNG inside (valid, and what Windows/Electron want). */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* Simple 256x256 globe: filled circle with latitude/longitude lines "carved out",
   matching the app's line-art globe mark. */
const S = 256, C = S / 2, R = 100;
const px = new Uint8Array(S * S * 4);

function set(x, y, r, g, b, a) {
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
/* teal brand color used across the app */
const TR = 0x2d, TG = 0xd4, TB = 0xa8;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - C + 0.5, dy = y - C + 0.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > R) continue;
    /* fill: solid teal disc */
    let a = 255;
    /* smooth edge */
    if (d > R - 1.5) a = Math.round(255 * (R - d) / 1.5);
    /* carve meridians: vertical ellipses rx in {30, 65, 98} */
    const meridians = [30, 65, 98];
    for (const rx of meridians) {
      const v = Math.abs(dx) / rx * R;           // "longitude" distance scaled to circle
      const lon = Math.abs(Math.asin(Math.max(-1, Math.min(1, dx / rx))) * (180 / Math.PI));
      if (rx === 98 ? Math.abs(d - R) < 3 : false) continue;
    }
    /* simpler approach below with explicit tests */
    set(x, y, TR, TG, TB, a);
  }
}
/* carve lines with distance tests */
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const dx = x - C + 0.5, dy = y - C + 0.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > R) continue;
    let carve = false;
    /* outline ring */
    if (Math.abs(d - R) < 3.2) carve = true;
    /* vertical outline ellipse (the sphere silhouette) */
    /* meridians: ellipses with rx = 32, 66 (viewed as vertical ellipses) */
    for (const rx of [32, 66]) {
      if (rx * rx === 0) continue;
      const ey = dy / R * Math.sqrt(Math.max(0, R * R - rx * rx)) ; // not needed
      const t = (dx * dx) / (rx * rx) + (dy * dy) / (R * R);
      if (Math.abs(t - 1) < 0.055) carve = true;
    }
    /* equator + tropics (horizontal lines, slightly flattened) */
    for (const ry of [R, 74]) {
      const t = (dx * dx) / (R * R) + (dy * dy) / (ry * ry);
      if (Math.abs(t - 1) < 0.05) carve = true;
    }
    if (carve) set(x, y, 0, 0, 0, 0);
  }
}

/* encode PNG (RGBA, no filter) */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; /* 8-bit RGBA */
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

/* wrap in ICO: 1 entry, 256px, PNG-compressed */
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; /* 0 means 256 */
ico[7] = 0; ico.writeUInt16LE(1, 8); ico.writeUInt16LE(32, 10);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
const out = Buffer.concat([ico, png]);
fs.mkdirSync(path.join(__dirname, "..", "build"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "..", "build", "disglobe.ico"), out);
fs.writeFileSync(path.join(__dirname, "..", "build", "disglobe-preview.png"), png);
console.log("disglobe.ico written:", out.length, "bytes");
