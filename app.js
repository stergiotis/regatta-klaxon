// Regatta Counter — vanilla PWA
// Phases: idle -> countdown -> racing
// Sync action snaps the countdown to the nearest whole minute.

const state = {
  phase: 'idle',                 // 'idle' | 'countdown' | 'racing'
  durationMs: 5 * 60 * 1000,     // for the next start
  zeroEpoch: 0,                  // epoch-ms when timer hits 0:00
  lastDisplayedSec: null,        // last whole second shown (for boundary detection)
  shakeSensitivity: 5,           // 1 (least sensitive) … 10 (most sensitive)
  shakeThreshold: 18,            // m/s² peak above adaptive baseline (derived from sensitivity)
};

// ---------- persisted settings ----------
const STORE_KEY = 'klaxon-settings';
const DEFAULTS = {
  sequenceMin: 5,
  soundOn: true,
  shakeOn: false,
  shakeSensitivity: 5,
};
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch { return {}; }
}
function persistSettings() {
  const seqEl = document.querySelector('input[name="seq"]:checked');
  const data = {
    sequenceMin: seqEl ? parseInt(seqEl.value, 10) : DEFAULTS.sequenceMin,
    soundOn: dom.sound.checked,
    shakeOn: dom.shake.checked,
    shakeSensitivity: state.shakeSensitivity,
  };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch { /* private mode etc. */ }
}
function clearStoredSettings() {
  try { localStorage.removeItem(STORE_KEY); } catch {}
}
// Map slider 1..10 to threshold ~30..3 m/s². Sensitivity 5 → 18 (the original default).
const sensitivityToThreshold = (s) => 33 - 3 * s;

const $ = (id) => document.getElementById(id);
const dom = {
  app:        $('app'),
  status:     $('status'),
  time:       $('time'),
  phase:      $('phase'),
  primary:    $('primary'),
  minus:      $('minus'),
  plus:       $('plus'),
  reset:      $('reset'),
  seq:        document.querySelectorAll('input[name="seq"]'),
  sound:      $('sound-toggle'),
  shake:      $('shake-toggle'),
  shakeSens:  $('shake-sensitivity'),
  shakeOut:   $('shake-sensitivity-out'),
  meterBar:   $('meter-bar'),
  meterThresh:$('meter-thresh'),
  calibrate:  $('calibrate'),
  clear:      $('clear-settings'),
};

// ---------- formatting ----------
function fmt(ms) {
  const sign = ms < 0 ? -1 : 1;
  const total = Math.abs(Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return { text: `${m}:${String(s).padStart(2, '0')}`, sign, totalSec: total * sign };
}

// ---------- audio output ----------
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function beep({ freq = 880, duration = 0.15, volume = 0.4, type = 'sine' } = {}) {
  if (!dom.sound.checked) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain).connect(ctx.destination);
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.start(t);
  osc.stop(t + duration + 0.05);
}
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}
// Spoken cues: pre-rendered MP3 files. Each Audio element is preloaded once
// and reused so playback is low-latency. Falls back to a synthesized beep if
// the file is unavailable (e.g. before the service worker has cached it).
const speechSrc = {
  m6: 'audio/minute_6.mp3', m5: 'audio/minute_5.mp3',
  m4: 'audio/minute_4.mp3', m3: 'audio/minute_3.mp3',
  m2: 'audio/minute_2.mp3', m1: 'audio/minute_1.mp3',
  s10: 'audio/sec_10.mp3',  s9: 'audio/sec_9.mp3',
  s8:  'audio/sec_8.mp3',   s7: 'audio/sec_7.mp3',
  s6:  'audio/sec_6.mp3',   s5: 'audio/sec_5.mp3',
  s4:  'audio/sec_4.mp3',   s3: 'audio/sec_3.mp3',
  s2:  'audio/sec_2.mp3',   s1: 'audio/sec_1.mp3',
  go:  'audio/go.mp3',     sync: 'audio/sync.mp3',
};
const speech = {};
function preloadSpeech() {
  for (const [k, src] of Object.entries(speechSrc)) {
    const a = new Audio(src);
    a.preload = 'auto';
    speech[k] = a;
  }
}

// iOS Safari requires a user gesture to unlock each <audio> individually.
// On the first user interaction we briefly play every element muted, which
// primes them so later programmatic calls actually produce sound. Without
// this, only the cue triggered in the gesture handler itself (minute_5 in
// start()) plays, and subsequent ticks (sec_10 ... sec_1, minute_4 ... 1)
// silently no-op because their Audio elements were never primed.
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked) return;
  speechUnlocked = true;
  for (const a of Object.values(speech)) {
    a.muted = true;
    try {
      const p = a.play();
      if (p && p.then) {
        p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; })
         .catch(() => { a.muted = false; });
      } else {
        a.pause(); a.currentTime = 0; a.muted = false;
      }
    } catch { a.muted = false; }
  }
}
function speak(key, fallback) {
  if (!dom.sound.checked) return;
  const a = speech[key];
  if (!a || a.error) { fallback && fallback(); return; }
  try {
    a.pause();
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => fallback && fallback());
  } catch { fallback && fallback(); }
}

function chirp() {
  // Two-tone ascending chirp (used as fallback for sync).
  const ctx = ensureAudio();
  if (!ctx) return;
  const t = ctx.currentTime;
  for (const n of [{ f: 660, s: 0, d: 0.07 }, { f: 990, s: 0.08, d: 0.10 }]) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.f;
    osc.connect(g).connect(ctx.destination);
    g.gain.setValueAtTime(0, t + n.s);
    g.gain.linearRampToValueAtTime(0.4, t + n.s + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + n.s + n.d);
    osc.start(t + n.s);
    osc.stop(t + n.s + n.d + 0.02);
  }
}

function signalMinute(min) {
  speak(`m${min}`, () => beep({ freq: 660, duration: 0.25, volume: 0.5 }));
  vibrate(120);
}
function signalTick(sec) {
  speak(`s${sec}`, () => beep({ freq: 880, duration: 0.08, volume: 0.35 }));
  vibrate(40);
}
function signalStart() {
  speak('go', () => beep({ freq: 440, duration: 0.9, volume: 0.55, type: 'square' }));
  vibrate([300, 80, 300]);
}
function signalSync() {
  speak('sync', chirp);
  vibrate(60);
}

// ---------- core timing ----------
function setPhase(next) {
  if (state.phase === next) return;
  state.phase = next;
  state.lastDisplayedSec = null;
}

function syncToWholeMinute(label = 'Sync') {
  if (state.phase !== 'countdown') return;
  const now = Date.now();
  const remaining = state.zeroEpoch - now;
  const snapped = Math.round(remaining / 60000) * 60000;
  state.zeroEpoch = now + snapped;
  signalSync();
  flashSync(label);
}

function adjustMinutes(delta) {
  if (state.phase !== 'countdown') return;
  state.zeroEpoch += delta * 60000;
  flashSync(delta > 0 ? '+1 min' : '−1 min');
}

function start() {
  ensureAudio(); // unlock for later programmatic playback
  state.zeroEpoch = Date.now() + state.durationMs;
  setPhase('countdown');
  signalMinute(Math.round(state.durationMs / 60000)); // confirm start with duration
  acquireWakeLock();
}

function stopRacing() {
  setPhase('idle');
  state.zeroEpoch = 0;
  releaseWakeLock();
}

function reset() {
  setPhase('idle');
  state.zeroEpoch = 0;
  releaseWakeLock();
}

function flashSync(label) {
  dom.status.textContent = label;
  dom.app.classList.remove('sync-flash');
  // restart animation
  void dom.app.offsetWidth;
  dom.app.classList.add('sync-flash');
  clearTimeout(flashSync._t);
  flashSync._t = setTimeout(() => { dom.status.textContent = ''; }, 1500);
}

// ---------- render loop ----------
function render() {
  const now = Date.now();
  let displayMs;
  let phaseClass = 'phase-idle';
  let phaseLabel = 'Ready';

  if (state.phase === 'idle') {
    displayMs = state.durationMs;
    phaseClass = 'phase-idle';
    phaseLabel = 'Ready';
    dom.primary.textContent = 'Start';
    dom.minus.disabled = true;
    dom.plus.disabled = true;
  } else if (state.phase === 'countdown') {
    const remaining = state.zeroEpoch - now;
    displayMs = remaining;
    if (remaining <= 0) {
      // transition to racing
      setPhase('racing');
      signalStart();
      return render();
    }
    if      (remaining > 4 * 60000) phaseClass = 'phase-far';
    else if (remaining > 60000)     phaseClass = 'phase-mid';
    else if (remaining > 10000)     phaseClass = 'phase-close';
    else                            phaseClass = 'phase-final';
    phaseLabel = 'Countdown';
    dom.primary.textContent = 'Sync';
    dom.minus.disabled = false;
    dom.plus.disabled = false;
  } else if (state.phase === 'racing') {
    const elapsed = now - state.zeroEpoch;
    displayMs = -elapsed; // negative = elapsed
    phaseClass = 'phase-racing';
    phaseLabel = 'Racing';
    dom.primary.textContent = 'Stop';
    dom.minus.disabled = true;
    dom.plus.disabled = true;
  }

  const f = fmt(displayMs);
  if (f.text !== dom.time.textContent) dom.time.textContent = f.text;
  dom.time.classList.toggle('negative', state.phase === 'racing');
  dom.phase.textContent = phaseLabel;

  // swap phase class
  if (!dom.app.classList.contains(phaseClass)) {
    dom.app.classList.remove('phase-idle', 'phase-far', 'phase-mid', 'phase-close', 'phase-final', 'phase-racing');
    dom.app.classList.add(phaseClass);
    dom.app.dataset.phase = phaseClass.replace('phase-', '');
    updateThemeColor(phaseClass);
  }

  // boundary-crossing audio cues (countdown only)
  if (state.phase === 'countdown') {
    const sec = Math.ceil((state.zeroEpoch - now) / 1000);
    if (state.lastDisplayedSec !== null && state.lastDisplayedSec > sec) {
      for (let s = state.lastDisplayedSec - 1; s >= sec && s >= 0; s--) {
        if (s === 0) continue; // start signal handled at transition
        if (s > 0 && s % 60 === 0) signalMinute(s / 60);
        else if (s > 0 && s <= 10) signalTick(s);
      }
    }
    state.lastDisplayedSec = sec;
  } else {
    state.lastDisplayedSec = null;
  }

  rafId = requestAnimationFrame(render);
}
let rafId = null;

const themeColors = {
  'phase-idle':   '#440154',
  'phase-far':    '#3b528b',
  'phase-mid':    '#21918c',
  'phase-close':  '#5ec962',
  'phase-final':  '#fde725',
  'phase-racing': '#21918c',
};
function updateThemeColor(cls) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && themeColors[cls]) meta.setAttribute('content', themeColors[cls]);
}

// ---------- wake lock ----------
let wakeLock = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* user-denied or unsupported */ }
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.phase !== 'idle' && !wakeLock) acquireWakeLock();
});

// ---------- shake-to-sync + calibration ----------
const METER_MAX = 30; // m/s² peak above baseline; bar pegs at 100% above this
let shakeBaseline = 9.81;
let lastShake = 0;
let calibrating = false;
let calibrationMaxPeak = 0;

// Ref-counted devicemotion listener so shake-to-sync and calibration can share it.
let motionRefs = 0;
let shakeOn = false;

function attachMotion() {
  motionRefs++;
  if (motionRefs === 1) window.addEventListener('devicemotion', onMotion);
}
function detachMotion() {
  motionRefs = Math.max(0, motionRefs - 1);
  if (motionRefs === 0) {
    window.removeEventListener('devicemotion', onMotion);
    updateMeter(0);
  }
}

function onMotion(e) {
  const a = e.acceleration || (e.accelerationIncludingGravity && {
    x: e.accelerationIncludingGravity.x,
    y: e.accelerationIncludingGravity.y,
    z: e.accelerationIncludingGravity.z,
  });
  if (!a || a.x == null) return;
  const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  shakeBaseline = shakeBaseline * 0.98 + mag * 0.02;
  const peak = Math.abs(mag - shakeBaseline);
  updateMeter(peak);

  if (calibrating) {
    if (peak > calibrationMaxPeak) calibrationMaxPeak = peak;
    return; // suppress sync triggers during calibration
  }

  if (state.phase !== 'countdown') return;
  const now = performance.now();
  if (peak > state.shakeThreshold && now - lastShake > 1200) {
    lastShake = now;
    syncToWholeMinute('Shake');
  }
}

async function ensureMotionPermission() {
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    try { return (await DeviceMotionEvent.requestPermission()) === 'granted'; }
    catch { return false; }
  }
  return true;
}

async function enableShake(on) {
  if (!!on === shakeOn) return;
  if (on) {
    if (!await ensureMotionPermission()) { dom.shake.checked = false; return; }
    shakeOn = true;
    attachMotion();
  } else {
    shakeOn = false;
    detachMotion();
  }
}

function updateMeter(peak) {
  if (!dom.meterBar) return;
  dom.meterBar.style.width = Math.min(100, (peak / METER_MAX) * 100) + '%';
}
function updateThresholdMarker() {
  if (!dom.meterThresh) return;
  dom.meterThresh.style.left = Math.min(100, (state.shakeThreshold / METER_MAX) * 100) + '%';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CALIBRATE_LABEL = 'Calibrate from a hard shake';

async function calibrateShake() {
  if (calibrating) return;
  if (!await ensureMotionPermission()) return;

  calibrating = true;
  calibrationMaxPeak = 0;
  attachMotion();
  dom.calibrate.disabled = true;

  for (let s = 3; s >= 1; s--) {
    dom.calibrate.textContent = `Shake hard! ${s}`;
    await sleep(1000);
  }

  detachMotion();
  calibrating = false;

  if (calibrationMaxPeak < 4) {
    dom.calibrate.textContent = 'Try again, shake harder';
    await sleep(1500);
    dom.calibrate.textContent = CALIBRATE_LABEL;
    dom.calibrate.disabled = false;
    return;
  }

  // Threshold ≈ 70% of recorded peak so a real-race shake reliably exceeds it,
  // mapped back through the slider scale.
  const newThreshold = calibrationMaxPeak * 0.7;
  const sens = Math.max(1, Math.min(10, Math.round((33 - newThreshold) / 3)));
  state.shakeSensitivity = sens;
  state.shakeThreshold = sensitivityToThreshold(sens);
  dom.shakeSens.value = sens;
  dom.shakeOut.value = sens;
  updateThresholdMarker();
  persistSettings();

  dom.calibrate.textContent = `Set to ${sens} (peak ${calibrationMaxPeak.toFixed(1)} m/s²)`;
  await sleep(2200);
  dom.calibrate.textContent = CALIBRATE_LABEL;
  dom.calibrate.disabled = false;
}

// ---------- input wiring ----------
dom.primary.addEventListener('click', () => {
  ensureAudio();
  unlockSpeech();
  if (state.phase === 'idle') start();
  else if (state.phase === 'countdown') syncToWholeMinute();
  else if (state.phase === 'racing') stopRacing();
});

// Catch-all: any first interaction primes the audio elements, so even
// shake-to-sync (which fires Sync without a click on Start first) is heard.
const firstGesture = () => {
  ensureAudio();
  unlockSpeech();
};
document.addEventListener('click',     firstGesture, { once: true, capture: true });
document.addEventListener('touchstart', firstGesture, { once: true, capture: true });
dom.minus.addEventListener('click', () => adjustMinutes(-1));
dom.plus.addEventListener('click',  () => adjustMinutes(+1));
dom.reset.addEventListener('click', reset);

dom.seq.forEach(r => r.addEventListener('change', (e) => {
  state.durationMs = parseInt(e.target.value, 10) * 60 * 1000;
  if (state.phase === 'idle') state.lastDisplayedSec = null;
  persistSettings();
}));

dom.shake.addEventListener('change', (e) => { enableShake(e.target.checked); persistSettings(); });
dom.sound.addEventListener('change', () => { ensureAudio(); persistSettings(); });

dom.shakeSens.addEventListener('input', (e) => {
  const s = parseInt(e.target.value, 10);
  state.shakeSensitivity = s;
  state.shakeThreshold = sensitivityToThreshold(s);
  dom.shakeOut.value = s;
  updateThresholdMarker();
  persistSettings();
});

dom.calibrate.addEventListener('click', calibrateShake);

dom.clear.addEventListener('click', () => {
  clearStoredSettings();
  applySettings(DEFAULTS);
  flashSync('Settings cleared');
});

// keyboard for desktop testing
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); dom.primary.click(); }
  else if (e.key === '+' || e.key === '=') adjustMinutes(+1);
  else if (e.key === '-') adjustMinutes(-1);
  else if (e.key === 'r' || e.key === 'R') reset();
});

// ---------- service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Apply a settings object to runtime state and the UI. Missing/invalid keys fall back to DEFAULTS.
function applySettings(s) {
  const merged = { ...DEFAULTS, ...s };

  // sequence
  const seq = [3, 5, 6].includes(merged.sequenceMin) ? merged.sequenceMin : DEFAULTS.sequenceMin;
  state.durationMs = seq * 60 * 1000;
  state.lastDisplayedSec = null;
  const seqEl = document.querySelector(`input[name="seq"][value="${seq}"]`);
  if (seqEl) seqEl.checked = true;

  // sound
  dom.sound.checked = merged.soundOn !== false;

  // sensitivity
  const sens = (typeof merged.shakeSensitivity === 'number' && merged.shakeSensitivity >= 1 && merged.shakeSensitivity <= 10)
    ? merged.shakeSensitivity : DEFAULTS.shakeSensitivity;
  state.shakeSensitivity = sens;
  state.shakeThreshold = sensitivityToThreshold(sens);
  dom.shakeSens.value = sens;
  dom.shakeOut.value = sens;
  updateThresholdMarker();

  // shake toggle: best-effort restore. iOS requires a user gesture for permission,
  // so enableShake will silently fail there and uncheck the box; user re-taps once per session.
  const wantShake = !!merged.shakeOn;
  dom.shake.checked = wantShake;
  enableShake(wantShake);
}

// ---------- start ----------
preloadSpeech();
applySettings(loadSettings());
render();
