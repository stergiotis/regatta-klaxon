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
function signalMinute()  { beep({ freq: 660, duration: 0.25, volume: 0.5 }); vibrate(120); }
function signalTick()    { beep({ freq: 880, duration: 0.08, volume: 0.35 }); vibrate(40); }
function signalStart()   { beep({ freq: 440, duration: 0.9,  volume: 0.55, type: 'square' }); vibrate([300, 80, 300]); }
// Sync confirmation: short two-tone ascending chirp. Distinct from minute/tick beeps.
function signalSync() {
  if (dom.sound.checked) {
    const ctx = ensureAudio();
    if (ctx) {
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
  }
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
  signalMinute(); // confirm start
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
        if (s > 0 && s % 60 === 0) signalMinute();
        else if (s > 0 && s <= 10) signalTick();
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

// ---------- shake-to-sync ----------
let shakeBaseline = 9.81;
let lastShake = 0;
function onMotion(e) {
  if (state.phase !== 'countdown') return;
  const a = e.acceleration || (e.accelerationIncludingGravity && {
    x: e.accelerationIncludingGravity.x,
    y: e.accelerationIncludingGravity.y,
    z: e.accelerationIncludingGravity.z,
  });
  if (!a || a.x == null) return;
  const mag = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
  // adaptive baseline (handles whether gravity is included)
  shakeBaseline = shakeBaseline * 0.98 + mag * 0.02;
  const peak = Math.abs(mag - shakeBaseline);
  const now = performance.now();
  if (peak > state.shakeThreshold && now - lastShake > 1200) {
    lastShake = now;
    syncToWholeMinute('Shake');
  }
}
async function enableShake(on) {
  if (on) {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') { dom.shake.checked = false; return; }
      } catch { dom.shake.checked = false; return; }
    }
    window.addEventListener('devicemotion', onMotion);
  } else {
    window.removeEventListener('devicemotion', onMotion);
  }
}

// ---------- input wiring ----------
dom.primary.addEventListener('click', () => {
  ensureAudio();
  if (state.phase === 'idle') start();
  else if (state.phase === 'countdown') syncToWholeMinute();
  else if (state.phase === 'racing') stopRacing();
});
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
  persistSettings();
});

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

  // shake toggle: best-effort restore. iOS requires a user gesture for permission,
  // so enableShake will silently fail there and uncheck the box; user re-taps once per session.
  const wantShake = !!merged.shakeOn;
  dom.shake.checked = wantShake;
  enableShake(wantShake);
}

// ---------- start ----------
applySettings(loadSettings());
render();
