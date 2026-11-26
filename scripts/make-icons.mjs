// Renders the toolbar icons (icons/icon-*.png) without any image library: two arrows pointing in
// opposite directions on a rounded square. Run with `npm run icons` after changing the design.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [36, 41, 47];
const FG = [255, 255, 255];
const SAMPLES = 4;

// Shapes in a 0..1 square.
const inRoundedSquare = (x, y, r = 0.22) => {
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
};
const inTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const inArrow = (x, y, cy, right) => {
  const ax = right ? x : 1 - x; // mirror the left-pointing arrow
  const shaft = ax >= 0.2 && ax <= 0.6 && Math.abs(y - cy) <= 0.05;
  const head = inTriangle(ax, y, [0.56, cy - 0.14], [0.56, cy + 0.14], [0.8, cy]);
  return shaft || head;
};
const inForeground = (x, y) => inArrow(x, y, 0.35, true) || inArrow(x, y, 0.65, false);

function render(size) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = [0]; // PNG filter type: none
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedSquare(x, y)) continue;
          if (inForeground(x, y)) fg++;
          else bg++;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = (bg + fg) / total;
      const mix = bg + fg ? fg / (bg + fg) : 0;
      row.push(...BG.map((c, i) => Math.round(c + (FG[i] - c) * mix)), Math.round(alpha * 255));
    }
    rows.push(Buffer.from(row));
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), render(size));
}
