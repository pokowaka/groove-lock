import './style.css';
import { AudioEngine } from './audio/audio-engine';
import type {
  DetectedPluckEvent,
  InputChannelMode,
  InstrumentRange,
  LoopbackSummary,
  MeterSnapshot,
} from './dsp/types';
import { type GradedPluckEntry, PocketGrader } from './groove/pocket-grader';
import {
  type GrooveLockProfile,
  loadProfile,
  saveProfile,
} from './groove/storage';
import {
  computeBarTarget,
  type DrillMode,
  type GapClickMode,
  type Subdivision,
  type TargetNoteEvent,
} from './groove/timeline';

const MAX_SCOPE_MS = 60;

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element #${id}`);
  }
  return el as T;
}

function bootstrapGrooveLock(): void {
  const dom = {
    audioLed: requireEl<HTMLSpanElement>('audio-led'),
    audioStatusText: requireEl<HTMLSpanElement>('audio-status-text'),
    connectAudioBtn: requireEl<HTMLButtonElement>('connect-audio-btn'),
    toggleMetronomeBtn: requireEl<HTMLButtonElement>('toggle-metronome-btn'),
    loopbackPingBtn: requireEl<HTMLButtonElement>('loopback-ping-btn'),
    calibrateBtn: requireEl<HTMLButtonElement>('calibrate-btn'),
    resetStatsBtn: requireEl<HTMLButtonElement>('reset-stats-btn'),
    calibrationBanner: requireEl<HTMLDivElement>('calibration-banner'),
    calibrationPromptText: requireEl<HTMLSpanElement>('calibration-prompt-text'),
    cancelCalibrateBtn: requireEl<HTMLButtonElement>('cancel-calibrate-btn'),
    deviceSelect: requireEl<HTMLSelectElement>('audio-device-select'),
    outputDeviceSelect: requireEl<HTMLSelectElement>('audio-output-select'),
    outputSinkStatus: requireEl<HTMLSpanElement>('output-sink-status'),
    channelSelect: requireEl<HTMLSelectElement>('input-channel-select'),
    sampleRateLabel: requireEl<HTMLSpanElement>('sample-rate-label'),
    peakDbReadout: requireEl<HTMLSpanElement>('peak-db-readout'),
    meterCh1: requireEl<HTMLDivElement>('meter-ch1'),
    meterCh2: requireEl<HTMLDivElement>('meter-ch2'),
    thresholdMarker1: requireEl<HTMLDivElement>('threshold-marker-1'),
    thresholdMarker: requireEl<HTMLDivElement>('threshold-marker'),
    thresholdSlider: requireEl<HTMLInputElement>('onset-threshold-slider'),
    thresholdValueLabel: requireEl<HTMLSpanElement>('threshold-value-label'),
    latencySlider: requireEl<HTMLInputElement>('latency-offset-slider'),
    latencyValueLabel: requireEl<HTMLSpanElement>('latency-value-label'),
    bpmInput: requireEl<HTMLInputElement>('bpm-input'),
    bpmDisplayVal: requireEl<HTMLSpanElement>('bpm-display-val'),
    subdivisionSelect: requireEl<HTMLSelectElement>('subdivision-select'),
    pocketWindowSelect: requireEl<HTMLSelectElement>('pocket-window-select'),
    gapModeSelect: requireEl<HTMLSelectElement>('gap-mode-select'),
    activeGridSummary: requireEl<HTMLSpanElement>('active-grid-summary'),
    beatLamps: [
      requireEl<HTMLDivElement>('beat-lamp-0'),
      requireEl<HTMLDivElement>('beat-lamp-1'),
      requireEl<HTMLDivElement>('beat-lamp-2'),
      requireEl<HTMLDivElement>('beat-lamp-3'),
    ],
    lastOffsetMs: requireEl<HTMLDivElement>('last-offset-ms'),
    timingVerdictBadge: requireEl<HTMLSpanElement>('timing-verdict-badge'),
    pocketZoneBox: requireEl<HTMLDivElement>('pocket-zone-box'),
    hitMarkersLayer: requireEl<HTMLDivElement>('hit-markers-layer'),
    statPocketPct: requireEl<HTMLSpanElement>('stat-pocket-pct'),
    statMeanMs: requireEl<HTMLSpanElement>('stat-mean-ms'),
    statJitterMs: requireEl<HTMLSpanElement>('stat-jitter-ms'),
    statTotalHits: requireEl<HTMLSpanElement>('stat-total-hits'),
    detectedFreqReadout: requireEl<HTMLSpanElement>('detected-freq-readout'),
    drillModeSelect: requireEl<HTMLSelectElement>('drill-mode-select'),
    instrumentRangeSelect: requireEl<HTMLSelectElement>('instrument-range-select'),
    detectedNoteName: requireEl<HTMLDivElement>('detected-note-name'),
    detectedCentsText: requireEl<HTMLSpanElement>('detected-cents-text'),
    targetNoteName: requireEl<HTMLDivElement>('target-note-name'),
    targetNoteStatus: requireEl<HTMLSpanElement>('target-note-status'),
    centsNeedle: requireEl<HTMLDivElement>('cents-needle'),
    noteHitRatio: requireEl<HTMLSpanElement>('note-hit-ratio'),
    historyRowsBody: requireEl<HTMLDivElement>('history-rows-body'),
  };

  const profile: GrooveLockProfile = loadProfile();
  const grader = new PocketGrader();

  let isCalibrating = false;
  let calibrationOffsetsMs: number[] = [];
  let isLoopbackPinging = false;

  const engine = new AudioEngine({
    onMeter: handleMeterSnapshot,
    onPluck: handlePluckEvent,
    onTargetScheduled: handleTargetScheduled,
    onBeatLamp: handleBeatLamp,
    onLoopbackComplete: handleLoopbackComplete,
  });

  function persistCurrentProfile(): void {
    saveProfile(profile);
  }

  function updateThresholdMarkerPosition(): void {
    const pct = Math.min(100, Math.max(0, (profile.onsetThreshold / 0.2) * 100));
    dom.thresholdMarker1.style.left = `${pct.toFixed(1)}%`;
    dom.thresholdMarker.style.left = `${pct.toFixed(1)}%`;
    dom.thresholdValueLabel.textContent = profile.onsetThreshold.toFixed(3);
  }

  function updatePocketZoneVisual(): void {
    const halfWidthPct = (profile.pocketWindowMs / MAX_SCOPE_MS) * 50;
    const leftPct = 50 - halfWidthPct;
    const widthPct = halfWidthPct * 2;
    dom.pocketZoneBox.style.left = `${leftPct.toFixed(2)}%`;
    dom.pocketZoneBox.style.width = `${widthPct.toFixed(2)}%`;
  }

  function updateGridSummaryText(): void {
    const subLabels: Record<Subdivision, string> = {
      1: 'Quarter Notes',
      2: 'Eighth Notes',
      3: 'Triplets',
      4: 'Sixteenth Notes',
    };
    dom.activeGridSummary.textContent = `${profile.bpm} BPM · ${subLabels[profile.subdivision]}`;
  }

  function updateTargetNoteDisplay(barNumber: number, overrideNote?: TargetNoteEvent['expectedNote']): void {
    const computed = computeBarTarget(profile.drillMode, barNumber);
    const noteToDisplay = overrideNote ?? computed.targetNote;
    dom.targetNoteName.textContent = noteToDisplay;
    dom.targetNoteStatus.textContent = computed.statusCaption;
  }

  function applyProfileToUiAndEngine(): void {
    dom.channelSelect.value = profile.selectedChannel;
    dom.thresholdSlider.value = String(profile.onsetThreshold);
    dom.latencySlider.value = String(profile.latencyCompensationMs);
    dom.latencyValueLabel.textContent = `${profile.latencyCompensationMs} ms`;
    dom.bpmInput.value = String(profile.bpm);
    dom.bpmDisplayVal.textContent = String(profile.bpm);
    dom.subdivisionSelect.value = String(profile.subdivision);
    dom.pocketWindowSelect.value = String(profile.pocketWindowMs);
    dom.gapModeSelect.value = String(profile.gapBars);
    dom.drillModeSelect.value = profile.drillMode;
    dom.instrumentRangeSelect.value = profile.instrumentRange;

    engine.setDspConfig({
      channelMode: profile.selectedChannel,
      onsetThreshold: profile.onsetThreshold,
      instrumentRange: profile.instrumentRange,
    });
    engine.setTransportConfig({
      bpm: profile.bpm,
      subdivision: profile.subdivision,
      gapBars: profile.gapBars,
      drillMode: profile.drillMode,
    });

    updateThresholdMarkerPosition();
    updatePocketZoneVisual();
    updateGridSummaryText();
    updateTargetNoteDisplay(0);
  }

  function populateDeviceDropdowns(
    inputs: readonly MediaDeviceInfo[],
    outputs: readonly MediaDeviceInfo[],
    resolvedInputId: string,
    resolvedOutputId: string,
  ): void {
    dom.deviceSelect.replaceChildren();
    inputs.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Audio Input ${idx + 1}`;
      if (dev.deviceId === resolvedInputId) {
        opt.selected = true;
      }
      dom.deviceSelect.appendChild(opt);
    });

    dom.outputDeviceSelect.replaceChildren();
    const defaultOutOpt = document.createElement('option');
    defaultOutOpt.value = '';
    defaultOutOpt.textContent = 'System Default Output';
    dom.outputDeviceSelect.appendChild(defaultOutOpt);

    outputs.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Audio Output ${idx + 1}`;
      if (dev.deviceId === resolvedOutputId) {
        opt.selected = true;
      }
      dom.outputDeviceSelect.appendChild(opt);
    });
  }

  async function applyOutputSinkSelection(
    sinkDeviceId: string,
    playConfirmationTick: boolean,
  ): Promise<void> {
    const status = await engine.applyOutputDevice(sinkDeviceId, playConfirmationTick);
    if (status === 'direct') {
      dom.outputSinkStatus.textContent = 'Direct Output';
    } else if (status === 'default') {
      dom.outputSinkStatus.textContent = 'System Default';
    } else if (status === 'unsupported') {
      dom.outputSinkStatus.textContent = 'macOS Default';
    } else {
      dom.outputSinkStatus.textContent = 'Fallback Default';
    }
  }

  async function connectAudioInterface(requestedDeviceId: string): Promise<void> {
    try {
      dom.audioStatusText.textContent = 'Connecting...';
      dom.audioLed.className = 'led-dot warn';

      const deviceLists = await engine.connectInput(
        requestedDeviceId,
        profile.selectedOutputDeviceId,
      );

      profile.selectedDeviceId = deviceLists.resolvedInputId;
      if (!profile.selectedOutputDeviceId && deviceLists.resolvedOutputId) {
        profile.selectedOutputDeviceId = deviceLists.resolvedOutputId;
      }
      persistCurrentProfile();

      populateDeviceDropdowns(
        deviceLists.inputs,
        deviceLists.outputs,
        profile.selectedDeviceId,
        profile.selectedOutputDeviceId,
      );

      await applyOutputSinkSelection(profile.selectedOutputDeviceId, false);

      const sr = engine.getOutputSampleRate();
      if (sr) {
        dom.sampleRateLabel.textContent = `${(sr / 1000).toFixed(1)} kHz`;
      }
      dom.audioLed.className = 'led-dot active';
      dom.audioStatusText.textContent = 'Scarlett Live';
      dom.connectAudioBtn.textContent = 'Reconnect Audio';
      dom.toggleMetronomeBtn.disabled = false;
      dom.loopbackPingBtn.disabled = false;
      dom.calibrateBtn.disabled = false;
    } catch {
      dom.audioLed.className = 'led-dot warn';
      dom.audioStatusText.textContent = 'Input Blocked / Error';
    }
  }

  function handleMeterSnapshot(snapshot: MeterSnapshot): void {
    const pct1 = Math.min(100, (snapshot.rmsCh0 / 0.2) * 100);
    const pct2 = Math.min(100, (snapshot.rmsCh1 / 0.2) * 100);
    dom.meterCh1.style.width = `${pct1.toFixed(1)}%`;
    dom.meterCh2.style.width = `${pct2.toFixed(1)}%`;

    if (snapshot.activeRms > 0.0001) {
      const db = 20 * Math.log10(snapshot.activeRms);
      dom.peakDbReadout.textContent = `${db.toFixed(1)} dB`;
    } else {
      dom.peakDbReadout.textContent = '-∞ dB';
    }
  }

  function handleTargetScheduled(event: TargetNoteEvent): void {
    grader.pushTargetEvent(event);
    if (event.beatInBar === 0 && event.subIndex === 0) {
      updateTargetNoteDisplay(event.barNumber, event.expectedNote);
    }
  }

  function handleBeatLamp(
    beatInBar: number,
    _barNumber: number,
    isSilentGapBar: boolean,
  ): void {
    dom.beatLamps.forEach((lamp, idx) => {
      lamp.className = 'beat-lamp';
      if (isSilentGapBar) {
        lamp.classList.add('gap-silent');
      }
      if (idx === beatInBar) {
        lamp.classList.add(idx === 0 ? 'active-downbeat' : 'active-beat');
      }
    });
  }

  function handlePluckEvent(pluck: DetectedPluckEvent): void {
    if (pluck.pitch) {
      dom.detectedNoteName.textContent = pluck.pitch.fullName;
      dom.detectedFreqReadout.textContent = `${pluck.pitch.freqHz.toFixed(1)} Hz`;
      const centsSign = pluck.pitch.cents >= 0 ? '+' : '';
      dom.detectedCentsText.textContent = `${centsSign}${pluck.pitch.cents} cents`;

      const clampedCents = Math.max(-50, Math.min(50, pluck.pitch.cents));
      const needlePct = 50 + (clampedCents / 50) * 50;
      dom.centsNeedle.style.left = `${needlePct.toFixed(1)}%`;
      dom.centsNeedle.style.backgroundColor =
        Math.abs(pluck.pitch.cents) <= 12
          ? 'var(--accent-pocket)'
          : 'var(--accent-amber)';
    } else {
      dom.detectedNoteName.textContent = 'X';
      dom.detectedCentsText.textContent = 'Percussive / Muted pluck';
    }

    if (!engine.isMetronomeRunning()) {
      return;
    }

    if (isCalibrating) {
      recordCalibrationHit(pluck.rawOnsetTimeSec);
      return;
    }

    const graded = grader.evaluatePluck(pluck, {
      latencyCompensationMs: profile.latencyCompensationMs,
      bpm: profile.bpm,
      subdivision: profile.subdivision,
      pocketWindowMs: profile.pocketWindowMs,
    });

    if (!graded) {
      return;
    }

    renderPluckFeedback(graded);
    renderPocketScopePips();
    renderSessionStats();
    renderHistoryRows();
  }

  function renderPluckFeedback(entry: GradedPluckEntry): void {
    const sign = entry.offsetMs >= 0 ? '+' : '';
    dom.lastOffsetMs.textContent = `${sign}${entry.offsetMs.toFixed(1)} ms`;

    if (entry.verdict === 'pocket') {
      dom.lastOffsetMs.style.color = 'var(--accent-pocket)';
      dom.timingVerdictBadge.textContent = 'IN THE POCKET';
      dom.timingVerdictBadge.style.backgroundColor = 'var(--accent-pocket-dim)';
      dom.timingVerdictBadge.style.color = 'var(--accent-pocket)';
    } else if (entry.verdict === 'rushing') {
      dom.lastOffsetMs.style.color = 'var(--accent-rush)';
      dom.timingVerdictBadge.textContent = `RUSHING (${Math.abs(entry.offsetMs).toFixed(0)} ms EARLY)`;
      dom.timingVerdictBadge.style.backgroundColor = 'hsla(14, 82%, 58%, 0.16)';
      dom.timingVerdictBadge.style.color = 'var(--accent-rush)';
    } else {
      dom.lastOffsetMs.style.color = 'var(--accent-drag)';
      dom.timingVerdictBadge.textContent = `DRAGGING (+${entry.offsetMs.toFixed(0)} ms LATE)`;
      dom.timingVerdictBadge.style.backgroundColor = 'hsla(202, 78%, 56%, 0.16)';
      dom.timingVerdictBadge.style.color = 'var(--accent-drag)';
    }

    if (entry.targetNote !== 'ANY') {
      dom.targetNoteName.style.color = entry.noteMatched
        ? 'var(--accent-pocket)'
        : 'var(--accent-miss)';
    } else {
      dom.targetNoteName.style.color = 'var(--accent-amber)';
    }
  }

  function renderPocketScopePips(): void {
    dom.hitMarkersLayer.replaceChildren();
    const recent = grader.getHistory().slice(0, 12);

    recent.forEach((item, idx) => {
      const pip = document.createElement('div');
      pip.className = idx === 0 ? 'hit-pip latest' : 'hit-pip';

      const clamped = Math.max(-MAX_SCOPE_MS, Math.min(MAX_SCOPE_MS, item.offsetMs));
      const leftPct = 50 + (clamped / MAX_SCOPE_MS) * 50;
      pip.style.left = `${leftPct.toFixed(2)}%`;

      if (item.inPocket) {
        pip.style.backgroundColor = 'var(--accent-pocket)';
      } else if (item.offsetMs < 0) {
        pip.style.backgroundColor = 'var(--accent-rush)';
      } else {
        pip.style.backgroundColor = 'var(--accent-drag)';
      }

      const opacity = Math.max(0.2, 1 - idx * 0.075);
      pip.style.opacity = opacity.toFixed(2);
      dom.hitMarkersLayer.appendChild(pip);
    });
  }

  function renderSessionStats(): void {
    const stats = grader.getStats(profile.pocketWindowMs);
    dom.statTotalHits.textContent = String(stats.totalHits);

    if (stats.totalHits === 0 || stats.inPocketPct === null || stats.meanOffsetMs === null || stats.stdDevMs === null) {
      dom.statPocketPct.textContent = '--%';
      dom.statMeanMs.textContent = '-- ms';
      dom.statJitterMs.textContent = '-- ms';
      dom.noteHitRatio.textContent = 'Note Match: --';
      return;
    }

    dom.statPocketPct.textContent = `${stats.inPocketPct}%`;
    const meanSign = stats.meanOffsetMs >= 0 ? '+' : '';
    dom.statMeanMs.textContent = `${meanSign}${stats.meanOffsetMs.toFixed(1)} ms`;
    dom.statJitterMs.textContent = `±${stats.stdDevMs.toFixed(1)} ms`;

    if (stats.noteAttempts > 0) {
      const notePct = Math.round((stats.noteMatches / stats.noteAttempts) * 100);
      dom.noteHitRatio.textContent = `Note Match: ${stats.noteMatches}/${stats.noteAttempts} (${notePct}%)`;
    } else {
      dom.noteHitRatio.textContent = 'Note Match: Free Mode';
    }
  }

  function renderHistoryRows(): void {
    dom.historyRowsBody.replaceChildren();
    const history = grader.getHistory();

    if (history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'Enable Scarlett input and start the click to log your notes.';
      dom.historyRowsBody.appendChild(empty);
      return;
    }

    history.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'history-row';

      const cBeat = document.createElement('span');
      cBeat.textContent = entry.beatLabel;

      const cNote = document.createElement('span');
      cNote.textContent = entry.noteLabel;
      if (entry.targetNote !== 'ANY' && !entry.noteMatched) {
        cNote.style.color = 'var(--accent-miss)';
      }

      const cOffset = document.createElement('span');
      const sign = entry.offsetMs >= 0 ? '+' : '';
      cOffset.textContent = `${sign}${entry.offsetMs.toFixed(1)} ms`;
      cOffset.style.color = entry.inPocket
        ? 'var(--accent-pocket)'
        : entry.offsetMs < 0
          ? 'var(--accent-rush)'
          : 'var(--accent-drag)';

      const cVerdict = document.createElement('span');
      if (entry.targetNote !== 'ANY' && !entry.noteMatched) {
        cVerdict.textContent = `Wrong Pitch (Want ${entry.targetNote})`;
        cVerdict.style.color = 'var(--accent-miss)';
      } else if (entry.inPocket) {
        cVerdict.textContent = 'Locked in Pocket';
        cVerdict.style.color = 'var(--accent-pocket)';
      } else if (entry.offsetMs < 0) {
        cVerdict.textContent = 'Rushing';
        cVerdict.style.color = 'var(--accent-rush)';
      } else {
        cVerdict.textContent = 'Dragging';
        cVerdict.style.color = 'var(--accent-drag)';
      }

      row.appendChild(cBeat);
      row.appendChild(cNote);
      row.appendChild(cOffset);
      row.appendChild(cVerdict);
      dom.historyRowsBody.appendChild(row);
    });
  }

  function toggleMetronomeUI(): void {
    if (engine.isMetronomeRunning()) {
      engine.stopMetronome();
      dom.toggleMetronomeBtn.textContent = 'Start Click (Space)';
      dom.toggleMetronomeBtn.classList.remove('btn-active-run');
      dom.beatLamps.forEach((lamp) => {
        lamp.className = 'beat-lamp';
      });
    } else {
      grader.clearTimeline();
      engine.startMetronome();
      dom.toggleMetronomeBtn.textContent = 'Stop Click (Space)';
      dom.toggleMetronomeBtn.classList.add('btn-active-run');
    }
  }

  function resetSessionStats(): void {
    grader.resetStats();
    dom.lastOffsetMs.textContent = '-- ms';
    dom.lastOffsetMs.style.color = 'var(--text-primary)';
    dom.timingVerdictBadge.textContent = 'Waiting for pluck...';
    dom.timingVerdictBadge.style.backgroundColor = 'var(--bg-control)';
    dom.timingVerdictBadge.style.color = 'var(--text-secondary)';
    dom.hitMarkersLayer.replaceChildren();
    renderSessionStats();
    renderHistoryRows();
  }

  function startTapCalibration(): void {
    isLoopbackPinging = false;
    engine.stopLoopbackPingTest();
    isCalibrating = true;
    calibrationOffsetsMs = [];
    dom.calibrationBanner.classList.add('visible');
    dom.calibrationPromptText.textContent =
      'TAP CALIBRATION: Pluck right on every quarter-note click (0 / 8 hits recorded)...';
    if (!engine.isMetronomeRunning()) {
      toggleMetronomeUI();
    }
  }

  function stopCalibration(): void {
    isCalibrating = false;
    isLoopbackPinging = false;
    engine.stopLoopbackPingTest();
    dom.calibrationBanner.classList.remove('visible');
  }

  function recordCalibrationHit(rawOnsetTimeSec: number): void {
    const match = grader.findNearestTarget(rawOnsetTimeSec, true);
    if (!match || Math.abs(match.offsetMs) > 160) {
      return;
    }

    calibrationOffsetsMs.push(match.offsetMs);
    dom.calibrationPromptText.textContent = `TAP CALIBRATION: Pluck right on every quarter-note click (${calibrationOffsetsMs.length} / 8 hits recorded)...`;

    if (calibrationOffsetsMs.length >= 8) {
      const sorted = [...calibrationOffsetsMs].sort((a, b) => a - b);
      const trimmed = sorted.slice(1, -1);
      const avgMs = Math.round(
        trimmed.reduce((acc, v) => acc + v, 0) / trimmed.length,
      );
      const clampedMs = Math.max(-20, Math.min(85, avgMs));

      profile.latencyCompensationMs = clampedMs;
      persistCurrentProfile();

      dom.latencySlider.value = String(clampedMs);
      dom.latencyValueLabel.textContent = `${clampedMs} ms`;
      dom.calibrationPromptText.textContent = `TAP CALIBRATED: Input latency compensation set to ${clampedMs} ms.`;
      isCalibrating = false;
    }
  }

  function startLoopbackPingTestUI(): void {
    isCalibrating = false;
    isLoopbackPinging = true;
    dom.calibrationBanner.classList.add('visible');
    dom.calibrationPromptText.textContent =
      'LOOPBACK PING: Connect patch cable from Scarlett Line Out -> Input, or hold bass pickup to speaker (measuring 6 pings)...';

    if (engine.isMetronomeRunning()) {
      toggleMetronomeUI();
    }
    engine.startLoopbackPingTest();
  }

  function handleLoopbackComplete(summary: LoopbackSummary): void {
    if (!isLoopbackPinging) {
      return;
    }
    isLoopbackPinging = false;

    if (!summary.success || summary.medianRtlMs === null) {
      dom.calibrationPromptText.textContent =
        'LOOPBACK FAILED: No return pings detected. Turn up Output/Gain or lower Pluck Sensitivity Threshold and retry.';
      return;
    }

    const clampedMs = Math.max(
      -20,
      Math.min(85, Math.round(summary.medianRtlMs)),
    );
    profile.latencyCompensationMs = clampedMs;
    persistCurrentProfile();

    dom.latencySlider.value = String(clampedMs);
    dom.latencyValueLabel.textContent = `${clampedMs} ms`;
    dom.calibrationPromptText.textContent = `LOOPBACK COMPLETE (${summary.detectedCount}/${summary.totalPulses} pings): Round-trip hardware latency = ${clampedMs} ms (applied!).`;
  }

  // Wire up event listeners
  dom.connectAudioBtn.addEventListener('click', () => {
    void connectAudioInterface(dom.deviceSelect.value || profile.selectedDeviceId);
  });

  dom.deviceSelect.addEventListener('change', () => {
    profile.selectedDeviceId = dom.deviceSelect.value;
    persistCurrentProfile();
    void connectAudioInterface(dom.deviceSelect.value);
  });

  dom.outputDeviceSelect.addEventListener('change', () => {
    profile.selectedOutputDeviceId = dom.outputDeviceSelect.value;
    persistCurrentProfile();
    void applyOutputSinkSelection(dom.outputDeviceSelect.value, true);
  });

  dom.channelSelect.addEventListener('change', () => {
    profile.selectedChannel = dom.channelSelect.value as InputChannelMode;
    persistCurrentProfile();
    engine.setDspConfig({ channelMode: profile.selectedChannel });
  });

  dom.thresholdSlider.addEventListener('input', () => {
    profile.onsetThreshold = parseFloat(dom.thresholdSlider.value);
    persistCurrentProfile();
    updateThresholdMarkerPosition();
    engine.setDspConfig({ onsetThreshold: profile.onsetThreshold });
  });

  dom.latencySlider.addEventListener('input', () => {
    profile.latencyCompensationMs = parseInt(dom.latencySlider.value, 10);
    persistCurrentProfile();
    dom.latencyValueLabel.textContent = `${profile.latencyCompensationMs} ms`;
  });

  dom.bpmInput.addEventListener('input', () => {
    profile.bpm = parseInt(dom.bpmInput.value, 10);
    persistCurrentProfile();
    dom.bpmDisplayVal.textContent = String(profile.bpm);
    engine.setTransportConfig({ bpm: profile.bpm });
    updateGridSummaryText();
  });

  dom.subdivisionSelect.addEventListener('change', () => {
    profile.subdivision = parseInt(dom.subdivisionSelect.value, 10) as Subdivision;
    persistCurrentProfile();
    engine.setTransportConfig({ subdivision: profile.subdivision });
    updateGridSummaryText();
  });

  dom.pocketWindowSelect.addEventListener('change', () => {
    profile.pocketWindowMs = parseInt(dom.pocketWindowSelect.value, 10);
    persistCurrentProfile();
    updatePocketZoneVisual();
    renderSessionStats();
  });

  dom.gapModeSelect.addEventListener('change', () => {
    profile.gapBars = parseInt(dom.gapModeSelect.value, 10) as GapClickMode;
    persistCurrentProfile();
    engine.setTransportConfig({ gapBars: profile.gapBars });
  });

  dom.drillModeSelect.addEventListener('change', () => {
    profile.drillMode = dom.drillModeSelect.value as DrillMode;
    persistCurrentProfile();
    engine.setTransportConfig({ drillMode: profile.drillMode });
    updateTargetNoteDisplay(engine.getCurrentBarNumber());
  });

  dom.instrumentRangeSelect.addEventListener('change', () => {
    profile.instrumentRange = dom.instrumentRangeSelect.value as InstrumentRange;
    persistCurrentProfile();
    engine.setDspConfig({ instrumentRange: profile.instrumentRange });
  });

  dom.toggleMetronomeBtn.addEventListener('click', () => {
    toggleMetronomeUI();
  });

  dom.resetStatsBtn.addEventListener('click', () => {
    resetSessionStats();
  });

  dom.loopbackPingBtn.addEventListener('click', () => {
    startLoopbackPingTestUI();
  });

  dom.calibrateBtn.addEventListener('click', () => {
    startTapCalibration();
  });

  dom.cancelCalibrateBtn.addEventListener('click', () => {
    stopCalibration();
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT') {
      return;
    }
    if (e.code === 'Space' && !dom.toggleMetronomeBtn.disabled) {
      e.preventDefault();
      toggleMetronomeUI();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      resetSessionStats();
    }
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void engine
        .enumerateAndResolveDevices(
          profile.selectedDeviceId,
          profile.selectedOutputDeviceId,
        )
        .then((lists) => {
          populateDeviceDropdowns(
            lists.inputs,
            lists.outputs,
            profile.selectedDeviceId,
            profile.selectedOutputDeviceId,
          );
        });
    });
  }

  applyProfileToUiAndEngine();
}

bootstrapGrooveLock();
