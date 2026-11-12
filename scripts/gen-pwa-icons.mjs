// WEB-UX-01 §4.10:PWA 图标生成(项目自有资产;零第三方依赖,zlib 手写 PNG 编码)。
// 产物:web/icons/icon-192.png / icon-512.png(Relay 蓝 + 白色 "R" 像素字)。
// 运行:node scripts/gen-pwa-icons.mjs(产物入库;修改后需重跑并提交)。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 8x8 像素 "R"(1=白)
const GLYPH = [
  [1, 1, 1, 1, 1, 1, 0, 0],
  [1, 0, 0, 0, 0, 1, 1, 0],
  [1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 0, 0, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 0, 0],
  [1, 0, 0, 0, 1, 0, 0, 0],
  [1, 0, 0, 0, 0, 1, 0, 0],
  [1, 0, 0, 0, 0, 0, 1, 0],
];

const BG = [0x1c, 0x3b, 0x63, 0xff]; // Relay 蓝
const FG = [0xff, 0xff, 0xff, 0xff];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function renderPng(size) {
  const px = Math.floor(size / 10); // 字形格宽
  const off = Math.floor((size - px * 8) / 2);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const gy = Math.floor((y - off) / px);
      const gx = Math.floor((x - off) / px);
      const inGlyph = gx >= 0 && gx < 8 && gy >= 0 && gy < 8 && GLYPH[gy][gx] === 1;
      const c = inGlyph ? FG : BG;
      raw[o++] = c[0];
      raw[o++] = c[1];
      raw[o++] = c[2];
      raw[o++] = c[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(join(ROOT, "web", "icons"), { recursive: true });
for (const size of [192, 512]) {
  const file = join(ROOT, "web", "icons", `icon-${size}.png`);
  writeFileSync(file, renderPng(size));
  console.log("wrote", file);
}
