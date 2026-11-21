/**
 * Confirm the speech fix is deployed.
 * Usage: node tools/check-speak-live.mjs [baseUrl]
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

const sw = await get('sw.js');
const v = /essay-reader-v(\d+)/.exec(sw.body)?.[1];
check('缓存版本 ≥ 13', Number(v) >= 13, `v${v}`);

const pin = await get('js/pin.js');
check('🔊 不再被关闭逻辑吞掉（isSpeakArea）', pin.body.includes('isSpeakArea'));
check('speak 已导出供生词本复用', pin.body.includes('export function speak'));
check('按设备选择英语语音', pin.body.includes('pickEnglishVoice'));
check('监听 voiceschanged', pin.body.includes('voiceschanged'));
check('处理 paused 卡死', pin.body.includes('synth.resume'));
check('发声失败会回报状态', pin.body.includes('announceSpeakResult'));

const app = await get('js/app.js');
check('生词本改用共享 ask speak', app.body.includes('MAX_CARDS, speak'));
check('接收 card:spoke 事件', app.body.includes('card:spoke'));
check('失败时给出提示', app.body.includes('announceSpeakFailure'));

const i18n = await get('js/i18n.js');
check('语音提示文案（中文）', i18n.body.includes('语音没有发声'));
check('语音提示文案（英文）', i18n.body.includes('No sound'));

const css = await get('css/app.css');
check('🔊 按下反馈样式', css.body.includes('card__speak--active'));

console.log(`\n${ok}/${total} 项确认`);
console.log(ok === total ? '结论：语音修复已上线。' : '结论：仍有未上线的改动。');