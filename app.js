// Regatta Counter — vanilla PWA
// Phases: idle -> countdown -> racing
// Sync action snaps the countdown to the nearest whole minute.

const state = {
  phase: 'idle',                 // 'idle' | 'countdown' | 'racing'
  durationMs: 5 * 60 * 1000,     // for the next start
  zeroEpoch: 0,                  // epoch-ms when timer hits 0:00
  shakeSensitivity: 5,           // 1 (least sensitive) … 10 (most sensitive)
  shakeThreshold: 18,            // m/s² peak above adaptive baseline (derived from sensitivity)
};

// ---------- persisted settings ----------
const STORE_KEY = 'klaxon-settings';
const SCHEMA_VERSION = 2; // v1: slider 1=least, 10=most sensitive (inverse of marker pos).
                          // v2: slider 1=low threshold (easy trigger), 10=high (hard trigger).
const DEFAULTS = {
  version: SCHEMA_VERSION,
  sequenceMin: 5,
  soundOn: true,
  shakeOn: false,
  shakeSensitivity: 6, // threshold = 3 × 6 = 18 m/s², matches the v1 default of 5.
};
function loadSettings() {
  try { return migrateSettings(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch { return {}; }
}
function migrateSettings(raw) {
  if (!raw || raw.version === SCHEMA_VERSION) return raw || {};
  // v1 -> v2: invert slider so value follows threshold, not sensitivity.
  // Keeps the user's tuned threshold the same; only the displayed number flips.
  if (typeof raw.shakeSensitivity === 'number') {
    raw.shakeSensitivity = 11 - raw.shakeSensitivity;
  }
  raw.version = SCHEMA_VERSION;
  return raw;
}
function persistSettings() {
  const seqEl = document.querySelector('input[name="seq"]:checked');
  const data = {
    version: SCHEMA_VERSION,
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
// Slider 1..10 maps directly to threshold m/s² above the adaptive baseline.
// 1 = low threshold (easy trigger), 10 = high (hard). Slider position therefore
// matches the threshold marker position on the meter.
const sensitivityToThreshold = (s) => 3 * s;

const $ = (id) => document.getElementById(id);
const dom = {
  app:        $('app'),
  status:     $('status'),
  time:       $('time'),
  phase:      $('phase'),
  primary:    $('primary'),
  minus:      $('minus'),
  plus:       $('plus'),
  stop:       $('stop'),
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
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// Spoken cues come from a single 6:02 master track played continuously
// during the countdown. Minute marks (6,5,4,3,2,1) and the last-10s
// ticks are pre-rendered at their canonical timestamps relative to the
// race-start mark at 360s, so the runtime only needs to start, stop,
// and seek a single HTMLAudioElement. This eliminates the per-cue
// HTMLAudioElement quirks on iOS and — because a continuously playing
// media element keeps Safari's audio session alive — the cues continue
// firing when the phone screen locks. MediaSession metadata also
// surfaces lock-screen controls.
const MASTER_SRC = 'audio/master.mp3';
const MASTER_RACE_MARK_S = 360; // track time at which 0:00 hits ("Race started!" is from this point)
let masterAudio = null;

function ensureMasterAudio() {
  if (!masterAudio) {
    masterAudio = new Audio(MASTER_SRC);
    masterAudio.preload = 'auto';
  }
  return masterAudio;
}
function trackTimeForRemaining(remainingMs) {
  return MASTER_RACE_MARK_S - remainingMs / 1000;
}
function startMasterAudio() {
  if (!dom.sound.checked) return;
  const a = ensureMasterAudio();
  const remaining = state.phase === 'countdown'
    ? state.zeroEpoch - Date.now()
    : state.durationMs;
  const t = trackTimeForRemaining(remaining);
  if (t < 0 || t > MASTER_RACE_MARK_S + 5) return;
  try { a.currentTime = t; } catch {}
  a.play().catch(() => {});
}
function stopMasterAudio() {
  if (!masterAudio) return;
  try { masterAudio.pause(); masterAudio.currentTime = 0; } catch {}
}
function seekMasterAudio() {
  if (!masterAudio || masterAudio.paused) return;
  const t = trackTimeForRemaining(state.zeroEpoch - Date.now());
  if (t >= 0 && t <= MASTER_RACE_MARK_S + 5) {
    try { masterAudio.currentTime = t; } catch {}
  }
}

// Sync confirmation: short Web Audio buffer or a synthesized chirp fallback.
// Sync-to-nearest-minute always seeks the master onto a cue, so the sync
// sound is delayed past the end of any in-flight cue to keep the spoken
// minute mark and "Sync" from talking over each other. Visual flash and
// vibration still fire immediately so the action remains responsive.
const MASTER_CUE_OFFSETS = [0, 60, 120, 180, 240, 300,
  350, 351, 352, 353, 354, 355, 356, 357, 358, 359, 360];
const MASTER_CUE_DURATION_S = 1.1; // longest cue ≈ 0.97s plus a small buffer
let syncBuffer = null;
async function preloadSync() {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const r = await fetch('audio/sync.mp3');
    if (r.ok) syncBuffer = await ctx.decodeAudioData(await r.arrayBuffer());
  } catch { /* fall back to chirp */ }
}
function masterCueOverlapDelayMs() {
  if (!masterAudio || masterAudio.paused) return 0;
  const t = masterAudio.currentTime;
  for (const cue of MASTER_CUE_OFFSETS) {
    if (t >= cue && t < cue + MASTER_CUE_DURATION_S) {
      return Math.max(0, (cue + MASTER_CUE_DURATION_S - t) * 1000);
    }
  }
  return 0;
}
function chirp() {
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
function playSyncSound() {
  const ctx = ensureAudio();
  if (ctx && syncBuffer) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = syncBuffer;
      src.connect(ctx.destination);
      src.start();
    } catch { chirp(); }
  } else {
    chirp();
  }
}
function signalSync() {
  vibrate(60);
  if (!dom.sound.checked) return;
  const delay = masterCueOverlapDelayMs();
  if (delay > 0) setTimeout(playSyncSound, delay + 80);
  else playSyncSound();
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Klaxon — Race Start',
      artist: 'Regatta start sequence',
      artwork: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    navigator.mediaSession.setActionHandler('pause', () => { if (state.phase !== 'idle') reset(); });
    navigator.mediaSession.setActionHandler('stop',  () => { if (state.phase !== 'idle') reset(); });
    navigator.mediaSession.setActionHandler('play',  () => { if (state.phase === 'countdown') startMasterAudio(); });
  } catch { /* unsupported actions are fine */ }
}

// ---------- core timing ----------
function setPhase(next) {
  if (state.phase === next) return;
  state.phase = next;
}

function syncToWholeMinute(label = 'Sync') {
  if (state.phase !== 'countdown') return;
  const now = Date.now();
  const remaining = state.zeroEpoch - now;
  const snapped = Math.round(remaining / 60000) * 60000;
  state.zeroEpoch = now + snapped;
  // Seek first so signalSync's cue-overlap check sees the new track position.
  seekMasterAudio();
  signalSync();
  flashSync(label);
}

function adjustMinutes(delta) {
  if (state.phase !== 'countdown') return;
  state.zeroEpoch += delta * 60000;
  seekMasterAudio();
  flashSync(delta > 0 ? '+1 min' : '−1 min');
}

function start() {
  ensureAudio();
  state.zeroEpoch = Date.now() + state.durationMs;
  setPhase('countdown');
  setupMediaSession();
  startMasterAudio();
  acquireWakeLock();
}

function stopRacing() {
  setPhase('idle');
  state.zeroEpoch = 0;
  stopMasterAudio();
  releaseWakeLock();
}

function reset() {
  setPhase('idle');
  state.zeroEpoch = 0;
  stopMasterAudio();
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
    dom.stop.hidden = true;
  } else if (state.phase === 'countdown') {
    const remaining = state.zeroEpoch - now;
    displayMs = remaining;
    if (remaining <= 0) {
      // The master track plays "Race started!" at MASTER_RACE_MARK_S, so
      // we let it continue rather than triggering a separate cue here.
      setPhase('racing');
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
    dom.stop.hidden = false;
  } else if (state.phase === 'racing') {
    const elapsed = now - state.zeroEpoch;
    displayMs = -elapsed; // negative = elapsed
    phaseClass = 'phase-racing';
    phaseLabel = 'Racing';
    dom.primary.textContent = 'Stop';
    dom.minus.disabled = true;
    dom.plus.disabled = true;
    dom.stop.hidden = true; // primary already says Stop
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
    if (!await ensureMotionPermission()) {
      dom.shake.checked = false;
      // Persist the denial so we don't keep asking on every load.
      persistSettings();
      return;
    }
    shakeOn = true;
    attachMotion();
  } else {
    shakeOn = false;
    detachMotion();
  }
}

// Some platforms (notably iOS) require a user gesture to grant motion access.
// applySettings() defers re-enabling shake-to-sync until the first gesture so
// the saved preference survives reloads instead of silently bouncing off.
let pendingShakeRestore = false;

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
  // mapped to the slider's 1..10 threshold scale.
  const newThreshold = calibrationMaxPeak * 0.7;
  const sens = Math.max(1, Math.min(10, Math.round(newThreshold / 3)));
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
  if (state.phase === 'idle') start();
  else if (state.phase === 'countdown') syncToWholeMinute();
  else if (state.phase === 'racing') stopRacing();
});

// Catch-all: any first interaction resumes the AudioContext so subsequent
// programmatic plays (including shake-to-sync) work without prior taps.
// The same gesture re-arms shake-to-sync on iOS if it was the saved choice.
const firstGesture = () => {
  ensureAudio();
  if (pendingShakeRestore && dom.shake.checked && !shakeOn) {
    pendingShakeRestore = false;
    enableShake(true);
  }
};
document.addEventListener('click',     firstGesture, { once: true, capture: true });
document.addEventListener('touchstart', firstGesture, { once: true, capture: true });
dom.minus.addEventListener('click', () => adjustMinutes(-1));
dom.plus.addEventListener('click',  () => adjustMinutes(+1));
dom.stop.addEventListener('click',  reset);
dom.reset.addEventListener('click', reset);

dom.seq.forEach(r => r.addEventListener('change', (e) => {
  state.durationMs = parseInt(e.target.value, 10) * 60 * 1000;
  persistSettings();
}));

dom.shake.addEventListener('change', (e) => { enableShake(e.target.checked); persistSettings(); });
dom.sound.addEventListener('change', () => {
  ensureAudio();
  persistSettings();
  if (state.phase === 'countdown') {
    if (dom.sound.checked) startMasterAudio();
    else stopMasterAudio();
  }
});

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

  // shake toggle: re-arm immediately on platforms where permission is automatic
  // (Android, desktop). On iOS, defer until the first user gesture so the
  // permission prompt is anchored to a real interaction and the preference
  // survives reloads instead of bouncing off.
  const wantShake = !!merged.shakeOn;
  dom.shake.checked = wantShake;
  const needsMotionGesture = typeof DeviceMotionEvent !== 'undefined' &&
                             typeof DeviceMotionEvent.requestPermission === 'function';
  if (wantShake) {
    if (needsMotionGesture) pendingShakeRestore = true;
    else enableShake(true);
  } else {
    pendingShakeRestore = false;
    enableShake(false);
  }
}

// ---------- start ----------
preloadSync();
ensureMasterAudio(); // start fetching the track immediately so play() is fast on first Start
applySettings(loadSettings());
render();
