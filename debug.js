/**
 * On-device tap diagnostics.
 *
 * The ✕ works first-try in every automated browser here, but fails on the
 * reader's phone. Rather than guess again, this page reports — on the phone
 * itself — what the browser actually delivers for each tap, so the failing
 * layer can be named instead of assumed.
 *
 * Open it with the app: essay-reader/tap-debug.html
 * It imports nothing and depends on nothing, so it works even if the app bundle
 * is stale in cache.
 */

const log = [];
const el = (id) => document.getElementById(id);

function add(line) {
  log.unshift(`${(performance.now() / 1000).toFixed(2)}s  ${line}`);
  if (log.length > 60) log.pop();
  el('log').textContent = log.join('\n');
}

function describe(target) {
  if (!target) return 'null';
  const cls = String(target.className || '').trim().split(/\s+/)[0];
  const id = target.id ? `#${target.id}` : '';
  return (target.tagName || '?').toLowerCase() + id + (cls ? `.${cls}` : '');
}

el('panel').addEventListener('touchstart', (e) => {
  add(`touchstart @ ${describe(e.target)}`);
  add(`   touches=${e.touches.length} cancelable=${e.cancelable}`);
}, true);

el('panel').addEventListener('touchmove', (e) => {
  add(`touchmove @ ${describe(e.target)}`);
}, true);

el('panel').addEventListener('touchend', (e) => {
  add(`touchend   @ ${describe(e.target)}  changed=${e.changedTouches.length}`);
}, true);

el('panel').addEventListener('pointerdown', (e) => {
  add(`pointerdown @ ${describe(e.target)} type=${e.pointerType}`);
}, true);

el('panel').addEventListener('pointerup', (e) => {
  add(`pointerup   @ ${describe(e.target)} type=${e.pointerType}`);
}, true);

el('panel').addEventListener('click', (e) => {
  // elementFromPoint at the click location shows whether something overlapped
  // the target — the occlusion case that produced the very first screenshot.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  add(`click      @ ${describe(e.target)}`);
  add(`   elementFromPoint -> ${describe(under)}`);
  if (under !== e.target && !e.target.contains(under)) {
    add('   >>> SOMETHING ELSE IS ON TOP AT THIS POINT');
  }
}, true);

el('panel').addEventListener('contextmenu', (e) => {
  add('contextmenu (long press)');
}, true);

// Environment snapshot: which browser, touch support, DPR, and the live CSS
// values that matter for tap latency.
add(`ua: ${navigator.userAgent}`);
add(`touch points: ${navigator.maxTouchPoints ?? 'n/a'}`);
add(`dpr: ${window.devicePixelRatio}  viewport: ${innerWidth}x${innerHeight}`);
add(`dark mode: ${matchMedia('(prefers-color-scheme: dark)').matches}`);
add(`hover:none ${matchMedia('(hover: none)').matches}  pointer:coarse ${matchMedia('(pointer: coarse)').matches}`);

// Report whether the real app's close button carries the touch-action fix.
fetch('./js/pin.js', { cache: 'no-store' })
  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((text) => {
    const hasPointerup = text.includes("addEventListener('pointerup'");
    const hasTouchend = text.includes("addEventListener('touchend'");
    const hasGuard = text.includes('TOGGLE_GUARD_MS');
    const hasBudget = text.includes('extrasBudget');
    add(`app bundle: pointerup=${hasPointerup} touchend=${hasTouchend} guard=${hasGuard} sizing=${hasBudget}`);
    if (!hasPointerup) add('>>> STALE CACHE: this is an old bundle');
  })
  .catch((err) => add(`app bundle check failed: ${err.message}`));

el('clear').addEventListener('click', () => {
  log.length = 0;
  el('log').textContent = '';
});