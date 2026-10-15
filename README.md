# GrooveLock

**A practice companion that helps bass players become masters of time.**

GrooveLock listens to your bass through an audio interface, plays a groove for you to lock into,
and shows you, to the millisecond, how each note landed: early, on time or late. Then it plays your
round back so you can *hear* it, works out what's going wrong, and gives you a drill aimed at
exactly that. The drill starts at a level you can pass and gets harder as you improve.

**▶ Try it: [pokowaka.github.io/groove-lock](https://pokowaka.github.io/groove-lock/)** (Chrome,
with an audio interface). No instrument at hand? Open
[the demo](https://pokowaka.github.io/groove-lock/?demo), which plays a simulated bassist.

![The Play view: a funk groove in the lane, each note block showing how the last hit landed](docs/images/play-view.png)

---

## Why

For a bass player, time *is* the job. But practicing with a metronome gives you almost no feedback:
you can't tell whether you're 10 ms ahead or 30 ms behind, whether you rush one particular note, or
whether your groove falls apart the moment the click goes away. Rhythm games are motivating, but they
mostly train you to *react to the screen* with loose timing windows, not to keep time yourself.

GrooveLock tries to combine the two:

- **Honest measurement:** sample-accurate note detection plus latency calibration, so the numbers
  reflect what you actually played. Detector accuracy is checked against real recordings in the
  test suite.
- **A loop that makes you want to keep going:** play until you nail it, hear the difference between
  your first try and the take that nailed it, a coach, a curriculum, and a roguelite run where the
  band joins you as you lock in.
- **Ears first:** nothing moves on screen that you could time against unless you ask for it. The
  goal is an internal pulse, not good reactions.

## What you can do with it

| | |
|---|---|
| **Play until you nail it** | Press Space: one bar of count-in, then keep playing until you've played N strict clean bars in a row (every note in the pocket, nothing extra). Then you hear the bars that nailed it, and can compare them with your first try. Hands-free: you never have to put the bass down. |
| **Groove Road** | Press **G** for a roguelite run: one continuous performance. Nail a stretch and you speed up, the rhythm changes, and the band joins (drums, hi-hats, percussion, keys on your root, a hook). Slip and you lose a heart. At a fork, play **E** or **A** on the 1 to choose the Fast lane or the Ghost road. Camps let you start where it gets hard; the run ends with a highlight reel. |
| **Follow the Time Path** | A curriculum from a steady pulse to odd meters (P). Includes *Off the Grid* (notes in odd places: the a of 2, displaced grooves, 3s across the bar line, strange rhythms) and *Note Length* (ending notes on time). |
| **See every note** | Each note block in the lane shows how your last hit landed (`−12 EARLY`, `+3 ON TIME`, `+15 LATE`) in green, orange or blue. A pocket meter, consistency meter (σ) and streaks track the session. |
| **Hear yourself** | Every round is recorded and played back on the results card: your bass and the groove, aligned exactly as they were graded. Switch between Mix / Bass / Drums, replay, or download a WAV. |
| **Get coached** | The Coach looks at your last few rounds, picks the one thing to fix ("you rush the 4-& by 13 ms", "you cut notes short by 30 ms"), and offers a drill. Drills level up each time you nail the goal (2, then 4, then 8 clean bars), start one level below your best, and count as mastered once you beat them on two different days. |
| **Practice real grooves** | Straight grids, Motown, funk 16ths, shuffle and 8th-note octaves, with a synthesized drum kit and reference bass. Options: click on every beat, 2 & 4, 1 only or the &s; silent bars; laid-back or pushed feel targets; echo/demo modes; note drills (cycle of 4ths, random notes). |
| **Note lengths** | The detector also finds where each note ends (when you mute it). Grooves with written lengths show a held-length bar under each note, and the results say if you cut notes short or let them ring. |
| **Track progress** | Round history, drill levels, camps and best runs are saved in your browser. The Path drawer shows the last 7 days and every drill's level. |

![The results card: playback with note markers, stats, and the Coach's suggestion](docs/images/results-card.png)

## Getting started

You need **Chrome**, a bass (or guitar), and an audio interface. GrooveLock was built around a
**Focusrite Scarlett Solo**, but any interface works.

1. Plug the bass into the interface's instrument input (on a Scarlett press **INST**) and set the
   gain so hard plucks stay green. GrooveLock warns you when the input clips.
2. Open the app and press **S** (Setup) → **Connect audio input**. Choose the interface as the
   output too, so the click and your bass share one clock.
3. Run **Loopback ping** once to measure your setup's latency: patch the headphone/line out into the
   input, or hold a headphone cup over the pickup. **Tap calibrate** is the alternative: pluck along
   with a slow click.
4. Close Setup and press **Space**.

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` | Play / stop (or next round) | `E` | Exercise settings |
| `Enter` | Next round now | `S` | Setup (audio, calibration, diagnostics) |
| `Esc` | Stay on the results / close drawer | `P` | Time Path (`N` next up) |
| `↑` `↓` | Tempo ±1 (`Shift` ±5) | `F` | Start the Coach's drill |
| `T` | Tap tempo | `X` | Exit the drill / end the run |
| `L` | Replay the take | `C` | Calibrate (when the Coach suggests it) |
| `R` | Reset session stats | `G` | Groove Road |

Tip: enable **Direct Monitor** on the interface so you hear your bass with zero latency.

## How it works

- **Note detection in the audio thread.** An `AudioWorklet` runs a cycle-safe onset detector (a
  32 ms envelope, so a low E at 41 Hz never re-triggers on its own waveform) and YIN pitch detection
  on every 128-sample block. Re-plucks on a ringing string must show a real rise in energy, which
  keeps clipped or ringing low notes from being counted twice.
- **Latency you can trust.** A loopback "sonar" ping measures the round trip (up to 400 ms), and
  tap calibration is the fallback. The input context runs on the interface's own clock, and the
  audio graph is rebuilt before a round once it is 10 minutes old, so the delay can't creep up while
  the page stays open. Setup shows the clock source and any drift.
- **Note ends, too.** A release tracker finds where each note is muted (a fast fall that stays
  down), checked against real recordings to within 15 ms.
- **One timeline.** Generated grooves produce `TargetNoteEvent`s that the grader matches plucks
  against (each beat is graded once). The same model is meant to drive songs and a scrolling note
  highway later.
- **Recordings re-render the groove.** Takes combine your recorded instrument audio with an offline
  re-synthesis of the exact drum and click events that were played. That keeps the backing clean and
  sample-aligned.
- **Diagnostics.** Setup → Diagnostics records both inputs plus the app's timing log.
  `tools/analyze_diagnostics.py` checks the detector against the waveform, clock health and drift
  offline.

More detail: [`src/DESIGN.md`](./src/DESIGN.md) (audio and DSP architecture),
[`UX_VISION.md`](./UX_VISION.md) (product direction, design principles, playtest decisions) and
[`ROADMAP.md`](./ROADMAP.md) (feature milestones).

## Where it's heading

Next up: more of the **Groove Road** (bosses in each region's style, more forks, modifiers), the
**style kit** (Reggae, Chic, Funk, Neo-soul grooves with their own pocket) and the **odd-meter
engine** (5/8, 7/8, 9/8 as chains of 2s and 3s), leading to math-rock in shifting meters. See
[`TIME_PATH.md`](./TIME_PATH.md), [`GROOVE_ROAD.md`](./GROOVE_ROAD.md) and
[`UX_VISION.md`](./UX_VISION.md).

---

## Development

```bash
nvm use          # Node 24 (see .nvmrc); Node >= 22 works
npm ci           # install exactly what package-lock.json pins
npm run dev      # dev server on http://127.0.0.1:8080 (add ?demo to preview without a bass)
npm run typecheck
npm test         # Vitest: DSP, grading, scoring, coach, takes, calibration, real-recording fixtures
npm run build    # production bundle in dist/
```

Every push to `main` runs typecheck, tests and build in GitHub Actions and deploys `dist/` to GitHub
Pages.

Useful extras:

- `?demo` simulates a player; `?demo&demoLatency=250` simulates an uncalibrated high-latency setup.
- `npx vite-node tools/replay-onsets.ts file.wav` replays a recording through the onset detector.
- `python3 tools/analyze_diagnostics.py groovelock-diag-….json` analyzes a diagnostics recording
  (needs numpy).

```text
groove-lock/
├── index.html                 # Play view, results card, Exercise / Setup / Progress drawers
├── UX_VISION.md               # Product direction, principles, playtest log
├── ROADMAP.md                 # Feature milestones
├── src/
│   ├── DESIGN.md              # Audio/DSP architecture
│   ├── main.ts                # UI controller
│   ├── dsp/                   # Pure DSP: onset detection, YIN pitch, loopback ping, pitch math
│   ├── audio/
│   │   ├── capture.worklet.ts # AudioWorklet: detection, metering, recording, diagnostics
│   │   ├── audio-engine.ts    # Input/output contexts, scheduler, count-in, rounds, clock lock
│   │   ├── drum-synth.ts      # Synthesized click, drums and reference bass
│   │   ├── take.ts            # Round recordings: alignment, offline re-render, playback, WAV
│   │   ├── diagnostics.ts     # Diagnostic recorder (WAV + JSON timing log)
│   │   └── clock-drift.ts     # Input-delay drift estimate
│   ├── groove/
│   │   ├── timeline.ts        # TargetNoteEvent model, note drills
│   │   ├── patterns.ts        # Groove patterns, click placement, reference bass modes
│   │   ├── pocket-grader.ts   # Matches plucks to targets, timing stats
│   │   ├── scoring.ts         # Judgments, groove meter, streaks, round summary
│   │   ├── drills.ts          # Coach: diagnosis, drill ladders, staircase
│   │   ├── history.ts         # Round history, drill progress, mastery
│   │   ├── calibration.ts     # Latency rules and latency-issue detection
│   │   ├── storage.ts         # Validated settings persistence
│   │   └── tap-tempo.ts
│   └── ui/                    # Canvas lane & pocket meter, controls, demo player
├── tests/                     # Vitest suites + fixtures/ (real Scarlett recordings)
└── tools/                     # Offline analysis and replay scripts
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
