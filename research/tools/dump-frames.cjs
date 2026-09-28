// Read-only inspector for multi-frame zstd JSONL session logs.
// Usage: node dump-frames.cjs <path> [maxEventLines]
const fs = require('node:fs');
const zlib = require('node:zlib');

const file = process.argv[2];
const maxEventLines = Number(process.argv[3] ?? 5);
const raw = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// Collect candidate frame starts (magic occurrences), keep those that decompress.
const starts = [];
for (let i = 0; i + 4 <= raw.length; i++) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i);
}
const frames = [];
for (const start of starts) {
  try {
    const out = zlib.zstdDecompressSync(raw.subarray(start));
    const next = starts.find((s) => s > start);
    // determine consumed length by binary search on a slice end
    let lo = 1, hi = raw.length - start, consumed = raw.length - start;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const o = zlib.zstdDecompressSync(raw.subarray(start, start + mid));
        if (o.length === out.length && o.equals(out)) { consumed = mid; hi = mid - 1; } else lo = mid + 1;
      } catch { lo = mid + 1; }
    }
    frames.push({ start, consumed, text: out.toString('utf8') });
    void next;
  } catch { /* not a real frame start */ }
}
console.log(`### ${file}`);
console.log(`compressedBytes=${raw.length} frames=${frames.length}`);
for (const f of frames.slice(0, 4)) {
  console.log(`--- frame@${f.start} consumed=${f.consumed} plaintext=${f.text.length}B ---`);
  console.log(f.text.split('\n').filter((l) => l).slice(0, maxEventLines).join('\n'));
}
const types = new Map();
let totalEvents = 0;
const headerLine = frames.length > 0 ? frames[0].text.split('\n')[0] : undefined;
for (const f of frames) {
  for (const line of f.text.split('\n')) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v.type === 'session' && line === headerLine) continue;
      totalEvents++;
      types.set(v.type ?? '<none>', (types.get(v.type ?? '<none>') ?? 0) + 1);
    } catch { types.set('<unparsable>', (types.get('<unparsable>') ?? 0) + 1); }
  }
}
console.log(`--- totalEventLines=${totalEvents} ---`);
for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`${v}\t${k}`);
// print one sample of the most common event type
if (types.size > 0) {
  const top = [...types.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const f of frames) for (const line of f.text.split('\n')) {
    if (!line || line === headerLine) continue;
    try { const v = JSON.parse(line); if (v.type === top) { console.log(`--- sample event type=${top} ---`); console.log(line.slice(0, 1200)); throw { done: true }; } } catch (e) { if (e && e.done) break; }
  }
}
