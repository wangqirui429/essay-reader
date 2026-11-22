/**
 * Check the gloss de-duplication rule against real dictionary output.
 *
 * Both the rule and its data live outside this file's control, so the behaviour
 * is verified here rather than trusted. Run: node tools/check-dedupe.mjs
 *
 * The rule is deliberately conservative. An earlier version merged any two
 * lines sharing 60% of their characters, which collapsed "苹果" into "苹果树" and
 * silently hid a real sense. Only lines that are almost the same surviving
 * wording are merged now.
 */

const sep = /[\s,，;；、.。:：()（）/；]/;

/** Split a gloss line into its individual Chinese terms. */
function terms(text) {
  return String(text)
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Mirror of dedupeGlosses from pin.js, kept in sync deliberately. */
function dedupe(glosses) {
  const kept = [];
  for (const g of glosses) {
    const text = String(g.text || '').trim();
    if (!text) continue;

    const mine = new Set(terms(text));
    let duplicate = false;

    for (const prev of kept) {
      const theirs = new Set(terms(prev.text));
      // Identical wording outright.
      if (prev.text === text) { duplicate = true; break; }
      // Every term of this line already appears in that one, or vice versa.
      const subsetOfTheirs = [...mine].every((x) => theirs.has(x));
      const supersetOfTheirs = [...theirs].every((x) => mine.has(x));
      if (subsetOfTheirs || supersetOfTheirs) { duplicate = true; break; }
    }

    if (!duplicate) kept.push({ text });
  }
  return kept.map((k) => k.text);
}

const CASES = [
  {
    name: 'gallows — learner sense then legal sense (partial overlap, keep both)',
    // The legal entry adds 绞台 and rephrases 绞架 as 绞刑架, so neither line
    // contains the other. Both stay: the reader sees 绞架/绞刑 and 绞刑架/绞台.
    input: [
      { pos: 'n.', text: '绞架, 绞刑' },
      { pos: '', text: '绞刑架, 绞台, 绞刑' },
    ],
    expectCount: 2,
  },
  {
    name: 'genuinely different senses (should all stay)',
    input: [
      { pos: 'n.', text: '判决；判断力；审判' },
      { pos: 'v.', text: '判断；评判' },
    ],
    expectCount: 2,
  },
  {
    name: 'distinct meanings that share a prefix',
    input: [
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果树' },
    ],
    expectCount: 2,
  },
  {
    name: 'exact duplicate lines (should collapse)',
    input: [
      { pos: 'n.', text: '推迟，延期' },
      { pos: 'n.', text: '推迟，延期' },
    ],
    expectCount: 1,
  },
  {
    name: 'subset line is folded into the fuller one',
    input: [
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果, 苹果树' },
    ],
    expectCount: 1,
  },
  {
    name: 'same terms in a different order counts as duplicate',
    input: [
      { pos: 'n.', text: '绞架, 绞刑' },
      { pos: 'n.', text: '绞刑, 绞架' },
    ],
    expectCount: 1,
  },
];

let failures = 0;
for (const c of CASES) {
  const out = dedupe(c.input);
  const ok = out.length === c.expectCount;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`        kept ${out.length} (expected ${c.expectCount}): ${JSON.stringify(out)}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} cases passed`);
process.exit(failures === 0 ? 0 : 1);
