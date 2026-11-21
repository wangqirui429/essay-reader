/**
 * Build a compact, browser-embeddable English -> Chinese dictionary from the
 * ECDICT open database (MIT, https://github.com/skywind3000/ECDICT).
 *
 * Keeps only words a learner is likely to look up, dedupes inflected forms into
 * their own entries, and writes a single JSON file the static app can load.
 *
 * Usage: node tools/build-dict.mjs [path/to/ecdict.csv]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CSV = process.argv[2] || path.join(ROOT, '..', 'ref', 'ecdict.csv');
const OUT_DIR = path.join(ROOT, '..', 'public', 'data');
const OUT = path.join(OUT_DIR, 'dict-min.json');

if (!fs.existsSync(CSV)) {
  console.error(`ECDICT csv not found at ${CSV}`);
  process.exit(1);
}

/** Minimal CSV row parser that honours quoted fields. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const EXAM_TAGS = /(zk|gk|cet4|cet6|ky|toefl|ielts|gre)/i;

/** Keep words a learner plausibly meets: ranked, tagged, or dictionary-listed. */
function worthKeeping(row) {
  const { word, translation, collins, oxford, tag, bnc, frq } = row;
  if (!word || !translation) return false;
  if (word.length > 40) return false;
  if (!/^[a-z][a-z'-]*$/.test(word)) return false;

  const collinsStar = Number(collins) > 0;
  const isOxford = Number(oxford) === 1;
  const hasExamTag = EXAM_TAGS.test(tag || '');
  const bncRank = Number(bnc) || 0;
  const cocaRank = Number(frq) || 0;
  const isFrequent = (bncRank > 0 && bncRank <= 30000) || (cocaRank > 0 && cocaRank <= 30000);

  return collinsStar || isOxford || hasExamTag || isFrequent;
}

/** Trim a multi-line translation to a few short senses. */
function condense(text) {
  const senses = String(text)
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((s) =>
      s
        // Drop subject labels such as [法] / [医] / [化] that only add noise here.
        .replace(/\[[^\]]{1,6}\]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 4);
  let out = senses.join('；');
  if (out.length > 160) out = out.slice(0, 158) + '…';
  return out;
}

/**
 * Irregular verb forms, so "went", "was" and "hanged" resolve even though
 * ECDICT stores them only on their lemma. Only the base entries are used, so
 * nothing is invented here.
 */
const IRREGULAR = {
  be: ['was', 'were', 'been', 'being', 'am', 'is', 'are'],
  go: ['went', 'gone', 'goes'],
  have: ['had', 'has', 'having'],
  do: ['did', 'done', 'does', 'doing'],
  take: ['took', 'taken', 'takes', 'taking'],
  come: ['came', 'comes', 'coming'],
  see: ['saw', 'seen', 'sees', 'seeing'],
  say: ['said', 'says', 'saying'],
  get: ['got', 'gotten', 'gets', 'getting'],
  make: ['made', 'makes', 'making'],
  know: ['knew', 'known', 'knows', 'knowing'],
  think: ['thought', 'thinks', 'thinking'],
  give: ['gave', 'given', 'gives', 'giving'],
  find: ['found', 'finds', 'finding'],
  tell: ['told', 'tells', 'telling'],
  become: ['became', 'becomes', 'becoming'],
  leave: ['left', 'leaves', 'leaving'],
  feel: ['felt', 'feels', 'feeling'],
  bring: ['brought', 'brings', 'bringing'],
  begin: ['began', 'begun', 'begins', 'beginning'],
  keep: ['kept', 'keeps', 'keeping'],
  hold: ['held', 'holds', 'holding'],
  write: ['wrote', 'written', 'writes', 'writing'],
  stand: ['stood', 'stands', 'standing'],
  hear: ['heard', 'hears', 'hearing'],
  let: ['lets', 'letting'],
  mean: ['meant', 'means', 'meaning'],
  set: ['sets', 'setting'],
  meet: ['met', 'meets', 'meeting'],
  run: ['ran', 'runs', 'running'],
  pay: ['paid', 'pays', 'paying'],
  sit: ['sat', 'sits', 'sitting'],
  speak: ['spoke', 'spoken', 'speaks', 'speaking'],
  lie: ['lay', 'lain', 'lies', 'lying'],
  lead: ['led', 'leads', 'leading'],
  read: ['reads', 'reading'],
  grow: ['grew', 'grown', 'grows', 'growing'],
  lose: ['lost', 'loses', 'losing'],
  fall: ['fell', 'fallen', 'falls', 'falling'],
  send: ['sent', 'sends', 'sending'],
  build: ['built', 'builds', 'building'],
  understand: ['understood', 'understands', 'understanding'],
  draw: ['drew', 'drawn', 'draws', 'drawing'],
  break: ['broke', 'broken', 'breaks', 'breaking'],
  spend: ['spent', 'spends', 'spending'],
  cut: ['cuts', 'cutting'],
  rise: ['rose', 'risen', 'rises', 'rising'],
  drive: ['drove', 'driven', 'drives', 'driving'],
  buy: ['bought', 'buys', 'buying'],
  wear: ['wore', 'worn', 'wears', 'wearing'],
  choose: ['chose', 'chosen', 'chooses', 'choosing'],
  seek: ['sought', 'seeks', 'seeking'],
  throw: ['threw', 'thrown', 'throws', 'throwing'],
  catch: ['caught', 'catches', 'catching'],
  deal: ['dealt', 'deals', 'dealing'],
  win: ['won', 'wins', 'winning'],
  forget: ['forgot', 'forgotten', 'forgets', 'forgetting'],
  hang: ['hanged', 'hung', 'hangs', 'hanging'],
  forget: ['forgot', 'forgotten', 'forgets', 'forgetting'],
  shake: ['shook', 'shaken', 'shakes', 'shaking'],
  strike: ['struck', 'strikes', 'striking'],
  sleep: ['slept', 'sleeps', 'sleeping'],
  eat: ['ate', 'eaten', 'eats', 'eating'],
  drink: ['drank', 'drunk', 'drinks', 'drinking'],
  fight: ['fought', 'fights', 'fighting'],
  sing: ['sang', 'sung', 'sings', 'singing'],
  swim: ['swam', 'swum', 'swims', 'swimming'],
  fly: ['flew', 'flown', 'flies', 'flying'],
  ride: ['rode', 'ridden', 'rides', 'riding'],
  wake: ['woke', 'woken', 'wakes', 'waking'],
  bear: ['bore', 'borne', 'bears', 'bearing'],
  beat: ['beaten', 'beats', 'beating'],
  bend: ['bent', 'bends', 'bending'],
  bite: ['bit', 'bitten', 'bites', 'biting'],
  blow: ['blew', 'blown', 'blows', 'blowing'],
  burn: ['burnt', 'burns', 'burning'],
  creep: ['crept', 'creeps', 'creeping'],
  dig: ['dug', 'digs', 'digging'],
  feed: ['fed', 'feeds', 'feeding'],
  hide: ['hid', 'hidden', 'hides', 'hiding'],
  hit: ['hits', 'hitting'],
  lend: ['lent', 'lends', 'lending'],
  light: ['lit', 'lights', 'lighting'],
  shut: ['shuts', 'shutting'],
  sink: ['sank', 'sunk', 'sinks', 'sinking'],
  slide: ['slid', 'slides', 'sliding'],
  spread: ['spreads', 'spreading'],
  steal: ['stole', 'stolen', 'steals', 'stealing'],
  stick: ['stuck', 'sticks', 'sticking'],
  sweep: ['swept', 'sweeps', 'sweeping'],
  tear: ['tore', 'torn', 'tears', 'tearing'],
  wind: ['wound', 'winds', 'winding'],
};

const entries = new Map();
let scanned = 0;
let kept = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(CSV, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let header = null;
await new Promise((resolve, reject) => {
  rl.on('line', (line) => {
    scanned += 1;
    if (!header) {
      header = parseCsvLine(line).map((h) => h.trim().toLowerCase());
      return;
    }
    if (line.trim().length < 3) return;
    const cells = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? '';

    const word = String(row.word || '').trim().toLowerCase();
    row.word = word;
    if (!worthKeeping(row)) return;

    const exchange = String(row.exchange || '');
    const def = {
      p: String(row.phonetic || '').replace(/^\/|\/$/g, '').trim(),
      t: condense(row.translation),
      x: String(row.tag || '').split(/\s+/).filter((t) => EXAM_TAGS.test(t)).slice(0, 5),
      f: Number(row.frq) || Number(row.bnc) || 0,
    };
    if (!def.t) return;

    entries.set(word, def);
    kept += 1;

    // Register inflected forms so "postponing"/"went" resolve on their own.
    // ECDICT exchange codes: p=past, d=past participle, i=ing, 3=3rd person,
    // r=comparative, t=superlative, s=plural, 0=lemma, 1=variants.
    for (const part of exchange.split('/')) {
      const m = /^([0-9a-z]):(.+)$/i.exec(part);
      if (!m) continue;
      const [, code, forms] = m;
      if (!'sdi3rt'.includes(code.toLowerCase())) continue;
      for (const form of forms.split(',').map((f) => f.trim().toLowerCase())) {
        if (form.length < 2 || form === word) continue;
        if (!/^[a-z][a-z'-]*$/.test(form)) continue;
        if (entries.has(form)) continue;
        entries.set(form, { p: def.p, t: def.t, x: def.x, f: def.f, l: word });
      }
    }
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

fs.mkdirSync(OUT_DIR, { recursive: true });

// Add irregular verb forms whose lemma is already in the dictionary.
let irregularAdded = 0;
for (const [lemma, forms] of Object.entries(IRREGULAR)) {
  const base = entries.get(lemma);
  if (!base) continue;
  for (const form of forms) {
    if (entries.has(form)) continue;
    entries.set(form, { p: base.p, t: base.t, x: base.x, f: base.f, l: lemma });
    irregularAdded += 1;
  }
}

const json = JSON.stringify(Object.fromEntries(entries));
fs.writeFileSync(OUT, json, 'utf8');

const mb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(`scanned rows: ${scanned}`);
console.log(`kept base entries: ${kept}`);
console.log(`irregular forms added: ${irregularAdded}`);
console.log(`with inflected forms: ${entries.size}`);
console.log(`written: ${OUT} (${mb} MB)`);
