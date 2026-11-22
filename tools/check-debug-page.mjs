/**
 * Confirm the on-device diagnostic page and the close fallbacks are live.
 * Usage: node tools/check-debug-page.mjs [baseUrl]
 */

const BASE = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';

const get = async (file) => {
  const r = await fetch(new URL(file, BASE) + '?t=' + Date.now(), {
    cache: 'no-store',
    signal: AbortSignal.timeout(25000),
  });
  return { status: r.status, body: await r.text() };
};

let ok = 0;
let total = 0;
const check = (name, passed, detail = '') => {
  total += 1;
  if (passed) ok += 1;
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const page = await get('tap-debug.html');
check('诊断页面可访问', page.status === 200, `HTTP ${page.status}`);
check('诊断页面无中文依赖问题', page.body.includes('点按诊断'));

const dbg = await get('debug.js');
check('诊断脚本可访问', dbg.status === 200, `HTTP ${dbg.status}`);
check('记录 pointerup', dbg.body.includes('pointerup'));
check('记录 touchend', dbg.body.includes('touchend'));
check('检测遮挡（elementFromPoint）', dbg.body.includes('elementFromPoint'));
check('检测旧缓存', dbg.body.includes('STALE CACHE'));

const pin = await get('js/pin.js');
check('close 走 pointerup', pin.body.includes("addEventListener('pointerup'"));
check('close 走 touchend', pin.body.includes("addEventListener('touchend'"));
check('三重机制防重复（closedAt）', pin.body.includes('closedAt'));

const sw = await get('sw.js');
const v = /essay-reader-v(\d+)/.exec(sw.body)?.[1];
check('缓存版本 ≥ 12', Number(v) >= 12, `v${v}`);

console.log(`\n${ok}/${total} 项确认`);