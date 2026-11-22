/**
 * Extract a few frames from a screen recording for inspection.
 *
 * No ffmpeg on this machine, so this uses the browser: a <video> element can
 * decode the mp4, and drawing it to a canvas gives PNG frames. Slow but exact.
 *
 * Usage: node tools/extract-frames.mjs <video.mp4> [count]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const VIDEO = process.argv[2];
const COUNT = Number(process.argv[3] || 6);
if (!VIDEO || !fs.existsSync(VIDEO)) {
  console.error('usage: node tools/extract-frames.mjs <video.mp4> [count]');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', 'verify', 'shots', 'video');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PORT = 9641;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = path.join(process.env.TEMP, `er-frames-${Date.now()}`);
const exe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 80 && !version; i += 1) {
  await sleep(300);
  try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { /* retry */ }
}
if (!version) { console.error('browser failed'); proc.kill(); process.exit(1); }

const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const job = pending.get(m.id);
  if (job) { pending.delete(m.id); job(m.result); }
});
const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); resolve({ timedOut: true }); } }, timeoutMs);
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.timedOut) throw new Error('timed out');
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
  return r.result.value;
};

await send('Page.enable');
await sleep(800);

// Load the video as a data URL so the file:// restriction never applies.
const dataUrl = `data:video/mp4;base64,${fs.readFileSync(VIDEO).toString('base64')}`;
console.log(`video size: ${(fs.statSync(VIDEO).size / 1024 / 1024).toFixed(2)} MB`);

await evalJs(`window.__url = ${JSON.stringify(dataUrl)}; true`);
const meta = await evalJs(`(async () => {
  const v = document.createElement('video');
  v.src = window.__url;
  v.muted = true;
  document.body.appendChild(v);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('decode failed')); setTimeout(() => rej(new Error('timeout')), 15000); });
  window.__video = v;
  return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
})()`);
console.log('duration:', `${meta.duration.toFixed(1)}s`, '| resolution:', `${meta.w}x${meta.h}`);

for (let i = 0; i < COUNT; i += 1) {
  const at = (meta.duration * (i + 0.5)) / COUNT;
  const shot = await evalJs(`(async () => {
    const v = window.__video;
    v.currentTime = ${at.toFixed(2)};
    await new Promise((res) => {
      if (Math.abs(v.currentTime - ${at.toFixed(2)}) < 0.05) return res();
      v.onseeked = res;
      setTimeout(res, 3000);
    });
    await new Promise(r => requestAnimationFrame(r));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL('image/png');
  })()`);
  const file = path.join(OUT_DIR, `frame-${String(i + 1).padStart(2, '0')}.png`);
  fs.writeFileSync(file, Buffer.from(shot.split(',')[1], 'base64'));
  console.log(`frame ${i + 1} @ ${at.toFixed(1)}s -> ${file}`);
}

ws.close();
proc.kill('SIGTERM');
await sleep(400);
try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* ignore */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
