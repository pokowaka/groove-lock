# GrooveLock

**GrooveLock** is a zero-dependency, single-file HTML5 Web Audio rhythm and pitch trainer built for bass and guitar players using a USB audio interface (such as a **Focusrite Scarlett Solo**).

It measures micro-timing accuracy (rushing vs. dragging in milliseconds) and pitch/note accuracy in real time so you can practice locking into the pocket.

---

## Features

- **Two-Stage Bass & Guitar DSP Engine:**
  - **Stage 1 — Real-Time Onset Detector (`AudioWorklet`):** Runs in 128-sample ($2.67\text{ ms}$) blocks on the dedicated Web Audio rendering thread. Uses a $32\text{ ms}$ ($1,536\text{-sample}$) cycle-integrated sustain envelope combined with a high-frequency derivative gate ($s[n] - s[n-1]$) so low bass fundamentals (such as open $\text{E}_1 = 41.2\text{ Hz}$, whose $24.3\text{ ms}$ wave period spans multiple audio blocks) never false-trigger on waveform zero-crossings.
  - **Stage 2 — YIN Autocorrelation Pitch Detector:** Evaluates fundamental pitch and intonation cents ($-50\text{¢}$ to $+50\text{¢}$) $48\text{ ms}$ after each pluck once the attack transient settles.
- **Independent Input & Output `AudioContext` Routing:**
  - Decouples the input capture `AudioContext` (with a zero-output `AudioWorkletNode` so the browser never plays back delayed instrument audio) from the output metronome `AudioContext`, allowing Chrome's `setSinkId()` to route the click track to any USB DAC or interface independently.
- **Automated Hardware Loopback Calibration (`Auto-Ping Loopback`):**
  - Emits 6 short $1760\text{ Hz}$ sonar pings and measures the exact sample arrival time on the input channel to calculate hardware round-trip latency ($\text{RTL}$) with sub-millisecond precision.
- **Practice Modes:**
  - **Subdivisions:** Quarter notes, 8th notes, triplets, and 16th notes.
  - **Gap Click Trainer:** Continuous 4/4 click, 3 bars click + 1 bar silent, or 2 bars click + 2 bars silent.
  - **Target Note Drills:** Free groove, Cycle of Fourths ($\text{E} \rightarrow \text{A} \rightarrow \text{D} \rightarrow \text{G} \rightarrow \text{C} \rightarrow \text{F}\dots$), Random note per bar, or single-note lock.

---

## Running Locally

Because browsers require a secure context (`http://127.0.0.1` or `https://`) to enumerate audio interface device names via `navigator.mediaDevices`, serve the folder locally:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open **http://127.0.0.1:8080** in Chrome.

---

## Focusrite Scarlett Solo Setup

1. **Instrument Input ($\frac{1}{4}\text{"}$ Jack):**
   - Plug your bass or guitar into the front $\frac{1}{4}\text{"}$ jack and press the **`INST`** button so the Hi-Z preamp is active.
   - Adjust the **Gain** knob so hard plucks light the halo **green** without clipping into red.
   - *Note on Scarlett Generations:* On **Scarlett Solo 4th Gen**, the front $\frac{1}{4}\text{"}$ jack is **Input 1**. On **Scarlett Solo 3rd Gen (and older)**, it is **Input 2**. GrooveLock's **Auto (Strongest of IN 1 / IN 2)** channel mode detects either automatically.
2. **Zero-Latency Hardware Monitoring:**
   - Enable **Direct Monitor** on the Scarlett front panel to hear your dry instrument in headphones/monitors with $0\text{ ms}$ latency, or turn **Direct Monitor** off if monitoring through an external amp.
3. **Calibrating Output-to-Input Latency:**
   - **Patch Cable Loopback (Method B):** Connect a $\frac{1}{4}\text{"}$ instrument cable from the Scarlett's **Headphone Output** (or Line Output) into the front **$\frac{1}{4}\text{"}$ Instrument Input**, set output and gain knobs around 10–11 o'clock, and click **Auto-Ping Loopback**.
   - **Magnetic Pickup Coupling (Method A):** Hold one headphone earcup directly over your bass/guitar pickup (with instrument volume up and strings muted) and click **Auto-Ping Loopback**.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
