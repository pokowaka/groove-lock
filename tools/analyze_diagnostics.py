#!/usr/bin/env python3
"""Offline timing analysis for GrooveLock diagnostic recordings.

Usage: python3 tools/analyze_diagnostics.py path/to/groovelock-diag-....json

Reads the JSON log and the matching stereo WAV (same folder) and reports:
  1. Clock health: gaps/overlaps between recorded chunks, and how the output-input clock offset
     moves over the session (drift between the two audio contexts).
  2. Detector accuracy: onsets found directly in the waveform vs. the onset times the app's
     detector reported (same input clock, so the player's timing doesn't matter).
  3. Timing vs. the clicks over the session: waveform onsets relative to scheduled targets,
     with a linear trend to reveal a delay that grows over time.
  4. Loopback ping results recorded during the session.
"""
import json
import sys
import wave
from pathlib import Path

import numpy as np


def load_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as w:
        channels = w.getnchannels()
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return data.reshape(-1, channels).T, rate


def detect_onsets(x: np.ndarray, rate: int, min_gap_sec: float = 0.12) -> np.ndarray:
    """Sample-accurate attack times: smoothed envelope crosses an adaptive threshold, then the
    exact start is refined to the first sample above 20% of the local peak."""
    env = np.convolve(np.abs(x), np.ones(int(rate * 0.002)) / int(rate * 0.002), mode='same')
    noise = np.percentile(env, 20)
    peak = np.percentile(env, 99.5)
    thresh = noise + 0.15 * (peak - noise)
    above = env > thresh
    onsets = []
    last = -1e9
    idx = np.flatnonzero(above[1:] & ~above[:-1]) + 1
    for i in idx:
        if (i - last) / rate < min_gap_sec:
            continue
        window = np.abs(x[max(0, i - int(rate * 0.01)) : i + int(rate * 0.02)])
        if window.size == 0:
            continue
        local_peak = window.max()
        start = max(0, i - int(rate * 0.01))
        first = start + int(np.argmax(window >= 0.2 * local_peak))
        onsets.append(first / rate)
        last = i
    return np.array(onsets)


def nearest(values: np.ndarray, t: float) -> float | None:
    if values.size == 0:
        return None
    return float(values[np.argmin(np.abs(values - t))])


def stats(name: str, ms: list[float]) -> None:
    if not ms:
        print(f'  {name}: no data')
        return
    a = np.array(ms)
    print(f'  {name}: n={a.size}  median={np.median(a):+.1f} ms  mean={a.mean():+.1f}  sd={a.std():.1f}  '
          f'min={a.min():+.1f}  max={a.max():+.1f}')


def main() -> None:
    json_path = Path(sys.argv[1])
    log = json.loads(json_path.read_text())
    wav_info = log['wav']
    audio, rate = load_wav(json_path.with_name(wav_info['file']))
    t0 = wav_info['startInputTimeSec']
    meta = log.get('meta', {})
    track = meta.get('inputTrack') or {}
    print(f'== {json_path.name}')
    print(f"  input: {meta.get('inputDeviceLabel')}  output: {meta.get('outputDeviceLabel')} ({meta.get('outputSinkStatus')})")
    print(f"  track settings: {track.get('settings')}")
    print(f"  context sample rate: {rate} Hz, duration {wav_info['durationSec']:.1f} s, "
          f"latency compensation {meta.get('profile', {}).get('latencyCompensationMs')} ms")

    print('\n1. Clock health')
    chunks = log['chunkTiming']
    gaps = []
    for prev, cur in zip(chunks, chunks[1:]):
        expected = prev['inputTimeSec'] + prev['frames'] / rate
        gaps.append((cur['inputTimeSec'] - expected) * 1000)
    big = [g for g in gaps if abs(g) > 1]
    print(f'  chunks: {len(chunks)}, discontinuities > 1 ms: {len(big)} {big[:10]}')
    offs = np.array([c['clockOffsetSec'] for c in chunks]) * 1000
    times = np.array([c['inputTimeSec'] for c in chunks])
    if offs.size > 2:
        slope = np.polyfit(times - times[0], offs, 1)[0]
        print(f'  output-input clock offset: first {offs[0]:.1f} ms, last {offs[-1]:.1f} ms, '
              f'range {offs.max() - offs.min():.1f} ms, trend {slope:+.3f} ms/s')

    print('\n2. Detector vs. waveform (same input clock)')
    onsets = [detect_onsets(audio[c], rate) + t0 for c in range(audio.shape[0])]
    for c, o in enumerate(onsets):
        print(f'  waveform onsets on input {c + 1}: {o.size}')
    ch = int(np.argmax([o.size for o in onsets]))
    wave_onsets = onsets[ch]
    errs = []
    for p in log['plucks']:
        t_in = p.get('inputOnsetTimeSec')
        if t_in is None:
            continue
        n = nearest(wave_onsets, t_in)
        if n is not None and abs(n - t_in) < 0.3:
            errs.append((t_in - n) * 1000)
    stats(f'detector minus waveform (input {ch + 1}; + = detector late)', errs)

    print('\n3. Waveform onsets vs. scheduled clicks (latency-compensated)')
    median_off = log['medianClockOffsetSec']
    comp = (meta.get('profile', {}).get('latencyCompensationMs') or 0) / 1000
    rel = []
    for tgt in log['targets']:
        t_in = tgt['timeSec'] - median_off
        n = nearest(wave_onsets, t_in + comp)
        if n is not None and abs(n - comp - t_in) < 0.35:
            rel.append((tgt['timeSec'] - log['targets'][0]['timeSec'], (n - comp - t_in) * 1000))
    if rel:
        r = np.array(rel)
        stats('waveform onset minus click (+ = late)', list(r[:, 1]))
        if len(r) > 4:
            slope = np.polyfit(r[:, 0], r[:, 1], 1)[0]
            print(f'  trend over session: {slope * 60:+.1f} ms per minute')
    graded = [g['offsetMs'] for g in log['graded']]
    stats("app's graded offsets", graded)

    print('\n4. Loopback pings')
    for lb in log['loopbacks']:
        print(f"  at {lb['atPerfMs'] / 1000:.1f} s: success={lb['success']} rtl={lb['medianRtlMs']} "
              f"({lb['detectedCount']}/{lb['totalPulses']})")
    for note in log.get('notes', []):
        print(f"  note @ {note['atPerfMs'] / 1000:.1f} s: {note['text']}")


if __name__ == '__main__':
    main()
