/**
 * Verify the Chinese interface.
 *
 * Checks three things a translation can get wrong: strings that were missed and
 * still render in English, Chinese that leaks where it should not, and the
 * language switch actually restoring English when asked.
 *
 * Usage: node verify/e2e-i18n.mjs [url]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_TO_TEST = process.argv[2] || 'http://127.0.0.1:5180/';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'shots');
const PORT = 9491;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const profile = path.join(process.env.TEMP, `er-i18n-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed to start'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, { resolve });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
  return r.result.value;
};

/**
 * Collect visible interface text that is NOT inside an essay body or meaning
 * card, along with the elements that still carry English.
 */
const UI_TEXT = `(() => {
  const skip = ['.essayBody', '#essayBody', '.card', '.wrow__zh', '.tile__excerpt', '.para'];
  const out = [];
  for (const el of document.querySelectorAll('button, h1, h2, h3, a, label, span, p, output, pre, .field__label, .nav a, .tool-label, .tool-hint, .set-note, .set-card__title, .section__title, .view__title, .view__lede, .empty, .dropzone, .wrow__word, .wrow__hits, .wrow__time, .tile__title, .tile__meta')) {
    if (!el.offsetParent && el.offsetHeight === 0) continue;
    let skipIt = false;
    for (const sel of skip) if (el.closest(sel)) { skipIt = true; break; }
    if (skipIt) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    if (text.length > 90) continue;
    out.push(text);
  }
  return [...new Set(out)];
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL_TO_TEST });
await sleep(4000);

/* 1 — the home page is Chinese */
const home = await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  title: document.title,
  brand: document.querySelector('.brand__text')?.textContent,
  nav: [...document.querySelectorAll('.nav a')].map(a => a.textContent.trim()),
  hero: document.querySelector('.hero__title')?.textContent?.trim(),
  importTitle: document.getElementById('importTitle')?.textContent?.trim(),
  readBtn: document.getElementById('impSave')?.textContent?.trim(),
  placeholder: document.getElementById('impText')?.getAttribute('placeholder')?.slice(0, 20)
})`);
const h = JSON.parse(home);
check('page language is Chinese', h.lang === 'zh-CN', h.lang);
check('title and brand are Chinese', CJK.test(h.title) && CJK.test(h.brand || ''), `${h.title} / ${h.brand}`);
check('navigation is Chinese', h.nav.every((n) => CJK.test(n)), h.nav.join(' | '));
check('hero and form labels are Chinese', CJK.test(h.hero || '') && CJK.test(h.importTitle || '') && CJK.test(h.readBtn || ''), `${h.hero?.slice(0, 18)} / ${h.readBtn}`);
check('text placeholder is Chinese', CJK.test(h.placeholder || ''), h.placeholder);

/* 2 — no leftover English in the chrome */
const uiTexts = await evalJs(UI_TEXT);
const englishLeft = uiTexts.filter((s) => /^[A-Za-z][A-Za-z0-9 ,.'!?—–-]{2,}$/.test(s) && !/^(A-|A\+|English|px)$/.test(s));
check('no leftover English labels on the home page', englishLeft.length === 0, englishLeft.join(' | ') || 'none');

await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
  fs.writeFileSync(path.join(OUT_DIR, '20-zh-home.png'), Buffer.from(r.data, 'base64')));

/* 3 — import an essay and read */
await evalJs(`(() => {
  document.getElementById('impTitle').value = '中文界面测试';
  document.getElementById('impText').value = 'A Slow Walk\\n\\nThe condemned man stepped aside to avoid a puddle, while the hangman waited beside the gallows. Nobody spoke.\\n\\nThe warders tightened their grip on his bound arms and the rope hung still above them.';
  document.getElementById('impSave').click();
})()`);
await evalJs(`(async () => {
  for (let i = 0; i < 60; i++) {
    if (document.querySelectorAll('.w').length) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
})()`);

const reader = await evalJs(`JSON.stringify({
  back: document.querySelector('[href="#/"]')?.textContent?.trim(),
  seen: document.getElementById('seenLabel')?.textContent,
  hint: document.querySelector('.tool-hint')?.textContent?.trim(),
  closeAll: document.getElementById('btnClearCards')?.textContent?.trim(),
  meta: document.getElementById('essayMeta')?.textContent,
  tokens: document.querySelectorAll('.w').length
})`);
const rd = JSON.parse(reader);
check('reader labels are Chinese', CJK.test(rd.back || '') && CJK.test(rd.hint || '') && CJK.test(rd.closeAll || ''), `${rd.back} | ${rd.closeAll}`);
check('reader progress label is Chinese', CJK.test(rd.seen || ''), rd.seen);
check('essay meta line is Chinese with a Chinese date', CJK.test(rd.meta || '') && /\d{4}年\d{1,2}月/.test(rd.meta || ''), rd.meta);
check('the English essay body is still rendered', rd.tokens > 20, `${rd.tokens} tokens`);

/* 4 — click a word: card labels Chinese, meaning Chinese */
await evalJs(`(() => {
  const w = [...document.querySelectorAll('.w')].find(x => x.dataset.w === 'gallows');
  const r = w.getBoundingClientRect();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    w.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  }
  return true;
})()`);
await evalJs(`(async () => {
  for (let i = 0; i < 120; i++) {
    const zh = document.querySelector('.card .card__zh');
    if (zh && zh.textContent.trim()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
})()`);

const card = await evalJs(`JSON.stringify({
  word: document.querySelector('.card .card__word')?.textContent,
  zh: document.querySelector('.card .card__zh')?.textContent?.slice(0, 20),
  closeTitle: document.querySelector('.card__close')?.getAttribute('title'),
  speakTitle: document.querySelector('.card__speak')?.getAttribute('title'),
  blockHeads: [...document.querySelectorAll('.card__block h4')].map(x => x.textContent.trim()),
  wordCount: document.querySelectorAll('.card .card__word').length,
  closeCount: document.querySelectorAll('.card .card__close').length,
  nestedBody: document.querySelectorAll('.card .card__body .card__body').length
})`);
const c = JSON.parse(card);
check('word meaning is still Chinese (the core feature)', CJK.test(c.zh || ''), `${c.word} → ${c.zh}`);
check('card controls are labelled in Chinese', CJK.test(c.closeTitle || '') && CJK.test(c.speakTitle || ''), `${c.closeTitle} / ${c.speakTitle}`);
check('the card is drawn once, with no duplicated header', c.wordCount === 1 && c.closeCount === 1 && c.nestedBody === 0, `words=${c.wordCount} closes=${c.closeCount} nested=${c.nestedBody}`);

await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
  fs.writeFileSync(path.join(OUT_DIR, '21-zh-card.png'), Buffer.from(r.data, 'base64')));

/* 5 — saved words panel */
await evalJs(`location.hash = '#/words'`);
await sleep(900);
const wordsView = await evalJs(`JSON.stringify({
  title: document.querySelector('.view--words .view__title')?.textContent?.trim(),
  lede: document.querySelector('.view--words .view__lede')?.textContent?.trim(),
  search: document.getElementById('wordSearch')?.getAttribute('placeholder'),
  removeBtn: document.querySelector('.wrow button[data-act="forget"]')?.textContent?.trim(),
  hits: document.querySelector('.wrow__hits')?.textContent?.trim(),
  count: document.getElementById('wordsCount')?.textContent
})`);
const wv = JSON.parse(wordsView);
check('saved words panel is Chinese', CJK.test(wv.title || '') && CJK.test(wv.lede || '') && CJK.test(wv.search || ''), `${wv.title} / ${wv.search}`);
check('word row labels are Chinese', CJK.test(wv.removeBtn || '') && CJK.test(wv.hits || ''), `${wv.removeBtn} | ${wv.hits}`);

/* 6 — settings, including the language switch */
await evalJs(`location.hash = '#/settings'`);
await sleep(1200);
const settings = await evalJs(`JSON.stringify({
  title: document.querySelector('.view--settings .view__title')?.textContent?.trim(),
  cards: [...document.querySelectorAll('.set-card__title')].map(x => x.textContent.trim()),
  themes: [...document.querySelectorAll('#themeGroup button')].map(x => x.textContent.trim()),
  langActive: document.querySelector('#langGroup button.is-active')?.dataset.lang,
  stats: document.getElementById('setStats')?.textContent?.slice(0, 40)
})`);
const st = JSON.parse(settings);
check('settings is Chinese', CJK.test(st.title || '') && st.cards.every((x) => CJK.test(x) || /English/.test(x)), `${st.title} | ${st.cards.join(', ')}`);
check('theme buttons are Chinese', st.themes.every((x) => CJK.test(x)), st.themes.join(' | '));
check('Chinese is the active language', st.langActive === 'zh', st.langActive);

await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
  fs.writeFileSync(path.join(OUT_DIR, '22-zh-settings.png'), Buffer.from(r.data, 'base64')));

/* 7 — switching to English actually restores English */
await evalJs(`document.querySelector('#langGroup button[data-lang="en"]').click()`);
await sleep(800);
const switched = await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  nav: [...document.querySelectorAll('.nav a')].map(a => a.textContent.trim()),
  title: document.querySelector('.view--settings .view__title')?.textContent?.trim(),
  homeHero: document.querySelector('.hero__title')?.textContent?.trim()
})`);
const sw = JSON.parse(switched);
check('switching to English re-renders the interface', sw.lang === 'en' && sw.nav.includes('Essays') && /Settings/.test(sw.title || ''), `${sw.nav.join(' | ')} | ${sw.title}`);

/* 8 — and back to Chinese, persisted */
await evalJs(`document.querySelector('#langGroup button[data-lang="zh"]').click()`);
await sleep(600);
await send('Page.reload');
await sleep(3500);
const persisted = await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  nav: [...document.querySelectorAll('.nav a')].map(a => a.textContent.trim())
})`);
const pe = JSON.parse(persisted);
check('the Chinese choice survives a reload', pe.lang === 'zh-CN' && pe.nav.every((n) => CJK.test(n)), `${pe.lang} | ${pe.nav.join(' | ')}`);

/* 9 — no uncaught errors through all of it */
check('no uncaught JavaScript errors', problems.length === 0, problems.join(' | ') || 'none');

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close();
proc.kill('SIGTERM');
await sleep(500);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.every((r) => r.ok) ? 0 : 1);
