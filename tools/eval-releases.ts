// Replays a WAV (16-bit, 32-bit int or float; first channel) through BassOnsetAnalyzer and prints
// note-length statistics from the detected releases.
// Usage: npx vite-node tools/eval-releases.ts <file.wav> [onsetThreshold]
import { readFileSync } from 'node:fs';
import { BassOnsetAnalyzer } from '../src/dsp/onset';
import type { ReleaseEvent } from '../src/dsp/release';

declare const process: { argv: string[] };

function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  let offset = 12;
  while (offset < buf.byteLength - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const bytes = bits / 8;
      const n = Math.floor(size / bytes / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = offset + 8 + i * bytes * channels;
        samples[i] =
          format === 3
            ? view.getFloat32(o, true)
            : bits === 16
              ? view.getInt16(o, true) / 32768
              : view.getInt32(o, true) / 2 ** 31;
      }
      return { samples, sampleRate };
    }
    offset += 8 + size;
  }
  throw new Error(`no data chunk in ${path}`);
}

const [path, thresholdArg] = process.argv.slice(2);
const { samples, sampleRate } = readWav(path);
const analyzer = new BassOnsetAnalyzer();
analyzer.setConfig({ channelMode: '0', onsetThreshold: Number(thresholdArg ?? 0.035), instrumentRange: 'bass' });
const silent = new Float32Array(128);
let onsets = 0;
const releases: ReleaseEvent[] = [];
for (let i = 0; i + 128 <= samples.length; i += 128) {
  const res = analyzer.processBlock(samples.subarray(i, i + 128), silent, i / sampleRate, sampleRate);
  onsets += res.completedPlucks.length;
  releases.push(...res.completedReleases);
}

const lens = releases.map((r) => (r.releaseTimeSec - r.onsetTimeSec) * 1000).sort((a, b) => a - b);
const q = (p: number): string => lens[Math.floor(p * (lens.length - 1))]?.toFixed(0) ?? '-';
const kinds: Record<string, number> = {};
for (const r of releases) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
console.log(`onsets ${onsets} · releases ${releases.length} ${JSON.stringify(kinds)}`);
console.log(`note length ms: p10 ${q(0.1)} · median ${q(0.5)} · p90 ${q(0.9)}`);
const short = releases.filter((r) => r.releaseTimeSec - r.onsetTimeSec < 0.08);
if (short.length > 0) {
  console.log(
    'short (<80 ms):',
    short.map((r) => `${r.onsetTimeSec.toFixed(3)}→${((r.releaseTimeSec - r.onsetTimeSec) * 1000).toFixed(0)}ms ${r.kind}`).join(', '),
  );
}
