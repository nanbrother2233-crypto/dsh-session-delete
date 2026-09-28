// Read-only inspector for DSH JSONL session logs (zstd-compressed JSONL).
// Usage: node dump-session.cjs <path-to-session.v3.jsonl.zstd> [maxLines]
const fs = require('node:fs');
const zlib = require('node:zlib');

const file = process.argv[2];
const maxLines = Number(process.argv[3] ?? 3);
const raw = fs.readFileSync(file);
let buf = raw;
if (file.endsWith('.zstd')) buf = zlib.zstdDecompressSync(raw);
const text = buf.toString('utf8');
const lines = text.split('\n').filter((l) => l.length > 0);
console.log(`### ${file}`);
console.log(`compressedBytes=${raw.length} decompressedBytes=${buf.length} lines=${lines.length}`);
for (let i = 0; i < Math.min(maxLines, lines.length); i++) {
  console.log(`--- line[${i}] (len=${lines[i].length}) ---`);
  console.log(lines[i]);
}
// event type histogram + first/last envelope keys
const types = new Map();
for (const line of lines) {
  try {
    const v = JSON.parse(line);
    const key = v.type ?? '<no type>';
    types.set(key, (types.get(key) ?? 0) + 1);
  } catch { types.set('<unparsable>', (types.get('<unparsable>') ?? 0) + 1); }
}
console.log('--- event type histogram ---');
for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`${v}\t${k}`);
try {
  const first = JSON.parse(lines[0]);
  console.log('--- header keys ---');
  console.log(Object.keys(first).join(', '));
} catch {}
