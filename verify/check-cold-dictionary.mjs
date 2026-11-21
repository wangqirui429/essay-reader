/**
 * A word tapped while the dictionary is still downloading must never be called
 * "not found".
 *
 * This is the bug the live site showed: on a slow connection the six dictionary
 * chunks take tens of seconds, and a reader tapping an ordinary word during that
 * window saw 「没有查到这个词的中文释义」 for a word that is in the dictionary.
 * The card also never corrected itself, so the reader had to close it and tap
 * again — which reads as "the app does not work".
 *
 * The dictionary is served 6 seconds late here so the window is wide enough to
 * click inside it deterministically.
 *
 * Usage: node verify/check-cold-dictionary.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { startSlowServer } from './slow-server.mjs';

const PORT = 9557;
const APP_PORT = 5206;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const slow = await startSlowServer({
  port: APP_PORT,
  delays: [
    { match: /^data\/instant\.json$/, ms: 1200 },
    { match: /^data\/core-\d+\.json$/, ms: 6000 },
    { match: /^data\/shards\//, ms: 6000 },
  ],
});

const profile = path.join(process.env.TEMP, `er-cold-${Date.now()}`);
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
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, 30000);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result?.value;
};
const waitFor = async (expr, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evalJs(expr)) return Date.now(); } catch { /* mid-load */ }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** Read the visible card: its text and whether it shows a Chinese meaning. */
const cardState = () => evalJs(`(() => {
  const card = document.querySelector('.card');
  if (!card) return { cards: 0 };
  return {
    cards: document.querySelectorAll('.card').length,
    text: card.textContent.replace(/\\s+/g, ' ').trim(),
    zh: [...card.querySelectorAll('.card__zh')].map((n) => n.textContent.trim()),
    noMeaning: /没有查到|No Chinese meaning/.test(card.textContent || ''),
    stillLoading: /还在下载|still downloading/.test(card.textContent || ''),
  };
})()`);

try {
  await send('Page.enable');
  await send('Runtime.enable');

  await send('Page.navigate', { url: slow.urls[0] });
  // A real boot signal: the shelf is only populated once app.js has run, whereas
// #impSave exists in the HTML long before any handler is attached to it.
  await waitFor(`!!document.querySelector('.shelf__empty, #shelf .tile')`, 'app boot');

  // Import an essay with one ordinary word and one nonsense word.
  await evalJs(`(() => {
    document.getElementById('impTitle').value = 'Cold Dictionary';
    document.getElementById('impText').value = 'The first paragraph explains the whole argument in one sentence.\\n\\nA second paragraph adds a detail, and then zzqx appears as a word no dictionary would hold.';
    document.getElementById('impSave').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#essayBody .w').length > 0`, 'essay opened').catch(async (err) => {
    const state = await evalJs(`(() => ({
      status: document.getElementById('impStatus')?.textContent,
      hash: location.hash,
      tiles: document.querySelectorAll('#shelf .tile').length,
      words: document.querySelectorAll('#essayBody .w').length,
    }))()`);
    throw new Error(`${err.message} ${JSON.stringify(state)}`);
  });

  // Tap "paragraph" while the chunks are still 6 seconds away.
  const tappedAt = Date.now();
  const word = await evalJs(`(() => {
    const w = [...document.querySelectorAll('#essayBody .w')].find((x) => x.dataset.w === 'paragraph');
    if (!w) return null;
    w.click();
    return w.dataset.w;
  })()`);
  check(word === 'paragraph', 'the test essay offers the word "paragraph" to tap');

  await waitFor(`!!document.querySelector('.card')`, 'card opened');
  // Give the lookup its grace window (2.5s) plus slack, but stop well before the
  // chunks arrive at 6s, which is precisely the window the bug lived in.
  await sleep(3600);

  const during = await cardState();
  check(during.cards === 1, 'exactly one card is open');
  check(
    during.noMeaning !== true,
    'the card does NOT claim the word is missing while the dictionary is still downloading',
    during.text.slice(0, 90),
  );
  check(
    /正在查|还在下载|Looking up|still downloading/.test(during.text),
    'the card says it is still looking',
    during.text.slice(0, 90),
  );

  // Now let the chunks land. The same card must fill itself in, with no new tap.
  const filled = await waitFor(`(() => {
    const card = document.querySelector('.card');
    return !!card && card.querySelectorAll('.card__zh').length > 0;
  })()`, 'the open card to fill itself in', 40000).catch(() => -1);

  const after = await cardState();
  check(filled >= 0, 'the open card fills itself in once the dictionary arrives', filled >= 0 ? `${Math.round((Date.now() - tappedAt) / 100) / 10}s after the tap` : 'never filled');
  check(after.zh.length > 0 && /段落|段/.test(after.zh.join(' ')), 'the meaning shown is the real Chinese gloss', after.zh.join(' / '));
  check(after.cards === 1, 'still exactly one card: no duplicate was opened to get there');

  // The word must have been recorded for the saved-words list.
  const saved = await evalJs(`(() => {
    location.hash = '#/words';
    return true;
  })()`);
  void saved;
  await waitFor(`document.querySelectorAll('#wordList .wrow').length > 0`, 'saved words list');
  const keys = await evalJs(`[...document.querySelectorAll('#wordList .wrow')].map((el) => el.dataset.key).join(',')`);
  check(keys.includes('paragraph'), 'the word is in the saved-words list', keys);

  // A genuinely unknown word must still be reported honestly — now that the
  // dictionary is complete, "not found" is a true statement.
  await evalJs(`location.hash = '#/essay'`);
  await evalJs(`(() => {
    const w = [...document.querySelectorAll('#essayBody .w')].find((x) => x.dataset.w === 'zzqx');
    w.click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('.card').length === 2 || (document.querySelectorAll('.card').length === 1 && !!document.querySelector('.card__zh'))`, 'second card', 20000);
  const nonsense = await waitFor(`(() => {
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find((c) => /zzqx/.test(c.textContent) && /没有查到/.test(c.textContent));
    return !!card;
  })()`, 'the honest "not found" message', 30000).catch(() => -1);
  check(nonsense >= 0, 'a word that really is absent still ends with the honest message');

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  await slow.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}