// Replays a mono 16-bit WAV through BassOnsetAnalyzer and prints detected onset times (seconds from
// the start of the file) as JSON. Usage: npx vite-node tools/replay-onsets.ts <file.wav> [threshold]
import { readFileSync } from 'node:fs';
import { BassOnsetAnalyzer } from '../src/dsp/onset';

declare const process: { argv: string[] };

const [path, thresholdArg] = process.argv.slice(2);
const buf = readFileSync(path);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const sampleRate = view.getUint32(24, true);
let offset = 12;
let samples = new Float32Array(0);
while (offset < buf.byteLength - 8) {
  const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
  const size = view.getUint32(offset + 4, true);
  if (id === 'data') {
    samples = new Float32Array(size / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
    break;
  }
  offset += 8 + size;
}
const analyzer = new BassOnsetAnalyzer();
analyzer.setConfig({ channelMode: '0', onsetThreshold: Number(thresholdArg ?? 0.035), instrumentRange: 'bass' });
const silent = new Float32Array(128);
const onsets: number[] = [];
for (let i = 0; i + 128 <= samples.length; i += 128) {
  const res = analyzer.processBlock(samples.subarray(i, i + 128), silent, i / sampleRate, sampleRate);
  for (const p of res.completedPlucks) onsets.push(Number(p.rawOnsetTimeSec.toFixed(5)));
}
console.log(JSON.stringify(onsets));
