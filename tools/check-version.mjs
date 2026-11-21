/**
 * Confirm the current deployment includes every fix.
 * Usage: node tools/check-version.mjs [url]
 */

const BASE = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';

const grab = async (file) => {
  const r = await fetch(new URL(file, BASE) + (file.includes('?') ? '&' : '?') + 't=' + Date.now(), {
    cache: 'no-store',
    signal: AbortSignal.timeout(25000),
  });
  return { status: r.status, text: await r.text() };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const html = await grab('index.html');
check('站点在线且为中文', /<html lang="zh-CN"/.test(html.text) && /英语作文阅读器/.test(html.text));

const pin = await grab('js/pin.js');
check('卡片跟随内容（无固定预留高度）', !pin.text.includes('reservedHeight') && !pin.text.includes('minHeight'));
check('定位避开粘性栏（stickyBarsBottom）', pin.text.includes('stickyBarsBottom'));
check('按词长估算卡片高度（estimateCardHeight）', pin.text.includes('estimateCardHeight'));
check('连点保护 900ms', pin.text.includes('TOGGLE_GUARD_MS'));
check('✕ 在卡片左上角', pin.text.indexOf('card__close') < pin.text.indexOf('card__word'));
check('点卡片头部任意位置关闭', pin.text.includes(`closest('.card__head')`));
check('小词条少显示短语例句（extrasBudget）', pin.text.includes('extrasBudget'));

const css = await grab('css/app.css');
check('卡片层在粘性栏之上（z-index 70）', /card-layer[^}]*z-index:\s*70/.test(css.text.replace(/\s+/g, ' ')) || css.text.includes('z-index: 70'));
check('触摸无延迟（touch-action）', css.text.includes('touch-action: manipulation'));
check('✕ 按钮 46px', css.text.includes('2.9rem'));

const i18n = await grab('js/i18n.js');
check('中文界面词条', i18n.text.includes('英语作文阅读器'));
check('新提示文案（点卡片顶部关闭）', i18n.text.includes('点卡片顶部任意位置即可关闭'));

const sw = await grab('sw.js');
const v = /essay-reader-v(\d+)/.exec(sw.text)?.[1];
check('缓存版本', Number(v) >= 11, `essay-reader-v${v}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 项确认`);
console.log(results.every((r) => r.ok) ? '结论：最新版本已完整上线。' : '\n结论：有改动未上线，需要重新发布。');
