# GrooveLock

**GrooveLock** is a low-latency TypeScript & Web Audio rhythm and pitch trainer built for bass and
guitar players using a USB audio interface (such as a **Focusrite Scarlett Solo**).

It measures micro-timing accuracy (rushing vs. dragging in milliseconds) and pitch/note accuracy in
real time so you can practice locking into the pocket.

---

## Architecture & Engineering

```text
groove-lock/
├── index.html                  # Studio rack layout
├── ROADMAP.md                  # Multi-milestone product & engineering roadmap
├── src/
│   ├── DESIGN.md               # Architectural deep-dive & onboarding guide
│   ├── dsp/                    # Pure Float32Array DSP (zero DOM/Web Audio coupling)
│   │   ├── types.ts            # Discriminated unions for main <-> worklet messaging
│   │   ├── pitch-utils.ts      # Frequency <-> MIDI / cents math & Circle of Fourths
│   │   ├── yin.ts              # YIN autocorrelation pitch detector with parabolic interpolation
│   │   ├── onset.ts            # 32ms cycle-safe sustain envelope + HF derivative onset detector
│   │   └── loopback.ts         # Sample-accurate 1760 Hz sonar ping RTL detector
│   ├── audio/
│   │   ├── capture.worklet.ts  # Real-time AudioWorkletProcessor running DSP in the audio thread
│   │   ├── drum-synth.ts       # Procedural Web Audio Kick, Snare, Hi-Hat & Click synthesizer
│   │   └── audio-engine.ts     # Dual-AudioContext hardware manager (inputCtx + outputCtx)
│   ├── groove/
│   │   ├── timeline.ts         # Universal TargetNoteEvent timeline & drill generators
│   │   ├── patterns.ts         # Syncopated groove templates, swing & click placement modes
│   │   ├── pocket-grader.ts    # Micro-timing offset, feel offset, Speed Trainer & jitter (σ)
│   │   └── storage.ts          # Validated localStorage hardware & practice profile persistence
│   ├── style.css               # Studio hardware rack stylesheet
│   └── main.ts                 # UI controller
└── tests/
    ├── dsp.test.ts             # Vitest DSP suite (Open E1 41.2Hz sustain immunity, YIN, RTL)
    └── pocket-grader.test.ts   # Vitest timing, groove pattern & pocket grading suite
```

### Key Technical Highlights

- **Real-Time `AudioWorklet` DSP Thread (`src/audio/capture.worklet.ts`):**
  - Runs the 4096-sample ring buffer, $32\text{ ms}$ ($1,536\text{-sample}$) cycle-integrated
    sustain envelope, high-frequency transient derivative gate ($s[n] - s[n-1]$), and YIN pitch
    detector directly on the dedicated Web Audio rendering thread.
  - Prevents low bass fundamentals (such as open $\text{E}_1 = 41.2\text{ Hz}$, whose
    $24.3\text{ ms}$ wave period spans multiple 128-sample blocks) from ever false-triggering on
    waveform zero-crossings.
- **The Pocket Laboratory (`src/groove/patterns.ts` & `src/audio/drum-synth.ts`):**
  - **Synthesized Studio Drum Kit & Electric Bass:** Zero-asset procedural Kick, Snare, Hi-Hat, and
    fingerstyle P-Bass synthesis so bassists can lock into a real groove instead of a sterile beep.
  - **Live Bass Line Toggle & Call-and-Response Guide:** Toggle **Bass Line: ON / OFF** at any time
    to hear what the selected pattern, BPM, target pitch, and pocket feel sound like on bass without
    stopping playback, or practice with **Call & Response (`1 Demo / 1 You` or `1 Demo / 3 You`)**.
  - **Click Placement Modes:** Practice with All 4 Beats, **Backbeat Only (Beats 2 & 4)**,
    **One-Drop (Beat 1 Only)**, or **Off-Beat `&` Only**.
  - **Syncopated Groove Patterns & 16-Step Indicator:** Built-in Motown (`1, 2-&, 3, 4`), Funk 16th
    syncopation, $62\%$ Swung Shuffle, and 8th-note Octave pulse templates with a live visual step
    strip.
  - **Intentional Pocket Feel Offset & Speed Trainer:** Shift the target pocket zone to **Laid-Back
    ($+12\text{ ms}$)** or **Pushed ($-8\text{ ms}$)**, and automatically step up $+2/+4\text{ BPM}$
    every 4 clean bars ($\ge 85\%$ in-pocket).
- **Independent Input & Output `AudioContext` Routing (`src/audio/audio-engine.ts`):**
  - Decouples the input capture `AudioContext` (using a zero-output `AudioWorkletNode` so the
    browser never plays back delayed instrument audio) from the output metronome `AudioContext`,
    allowing Chrome's `setSinkId()` to route the click track to any USB DAC or interface
    independently.
- **Automated Hardware Loopback Calibration (`src/dsp/loopback.ts`):**
  - Emits 6 short $1760\text{ Hz}$ sonar pings and measures the exact sample arrival time on the
    input channel to calculate hardware round-trip latency ($\text{RTL}$) with sub-millisecond
    precision.
- **Universal `TargetNoteEvent` Timeline (`src/groove/timeline.ts`):**
  - Designed to support both procedural metronome drills today and timed external song/tab beatmaps
    in future iterations (see [`ROADMAP.md`](./ROADMAP.md) and [`src/DESIGN.md`](./src/DESIGN.md)).

---

## Development & Testing

```bash
# Install dependencies
npm install

# Start local Vite dev server on http://127.0.0.1:8080
npm run dev

# Run strict TypeScript typecheck
npm run typecheck

# Run deterministic DSP & PocketGrader unit tests (Vitest)
npm test

# Build production bundle into dist/
npm run build
```

---

## Focusrite Scarlett Solo Setup

1. **Instrument Input ($\frac{1}{4}\text{"}$ Jack):**
   - Plug your bass or guitar into the front $\frac{1}{4}\text{"}$ jack and press the **`INST`**
     button so the Hi-Z preamp is active.
   - Adjust the **Gain** knob so hard plucks light the halo **green** without clipping into red.
   - _Note on Scarlett Generations:_ On **Scarlett Solo 4th Gen**, the front $\frac{1}{4}\text{"}$
     jack is **Input 1**. On **Scarlett Solo 3rd Gen (and older)**, it is **Input 2**. GrooveLock's
     **Auto (Strongest of IN 1 / IN 2)** channel mode detects either automatically.
2. **Zero-Latency Hardware Monitoring:**
   - Enable **Direct Monitor** on the Scarlett front panel to hear your dry instrument in
     headphones/monitors with $0\text{ ms}$ latency, or turn **Direct Monitor** off if monitoring
     through an external amp.
3. **Calibrating Output-to-Input Latency:**
   - **Patch Cable Loopback (Method B):** Connect a $\frac{1}{4}\text{"}$ instrument cable from the
     Scarlett's **Headphone Output** (or Line Output) into the front **$\frac{1}{4}\text{"}$
     Instrument Input**, set output and gain knobs around 10–11 o'clock, and click **Auto-Ping
     Loopback**.
   - **Magnetic Pickup Coupling (Method A):** Hold one headphone earcup directly over your
     bass/guitar pickup (with instrument volume up and strings muted) and click **Auto-Ping
     Loopback**.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
