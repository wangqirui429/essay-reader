/**
 * Confirm the deployed site is serving the Chinese interface.
 *
 * Usage: node tools/check-live.mjs [url]
 */

const URL_TO_TEST = process.argv[2] || 'https://wangqirui429.github.io/essay-reader/';

const res = await fetch(URL_TO_TEST, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
const html = await res.text();

const title = /<title>(.*?)<\/title>/.exec(html)?.[1] || '(none)';
const lang = /<html lang="(.*?)"/.exec(html)?.[1] || '(none)';

console.log(`status : ${res.status}`);
console.log(`title  : ${title}`);
console.log(`lang   : ${lang}`);
console.log(`hero   : ${/读英语文章/.test(html) ? 'Chinese (ok)' : 'not Chinese'}`);
console.log(`nav    : ${/生词本/.test(html) ? 'Chinese (ok)' : 'not Chinese'}`);
console.log(`i18n   : ${html.includes('./js/i18n.js') || html.includes('js/app.js') ? 'loaded via app.js' : 'missing'}`);

for (const file of ['js/i18n.js', 'js/app.js', 'sw.js', 'manifest.json']) {
  const r = await fetch(new URL(file, URL_TO_TEST), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  console.log(`${file.padEnd(16)} ${r.status}`);
}
