/**
 * Pinned meaning cards — the core interaction.
 *
 * Rules this module must never break:
 *   - A card appears when the reader clicks a word.
 *   - The card shows that word's Chinese meaning.
 *   - The card stays on screen until the user closes it, either with the ✕
 *     button or by clicking the same word again.
 *   - Nothing auto-closes a card: no timer, no outside click, no scrolling,
 *     no hover-out, no switching to another paragraph.
 *
 * Cards are absolutely positioned in document coordinates next to the word
 * they explain, so they remain glued to that word while the page scrolls.
 */

import { lookup } from './dict.js';
import { awaitDictionary } from './dict-offline.js';
import * as state from './state.js';
import { escapeHtml } from './tokenize.js';
import { t } from './i18n.js';

/** Hard cap so a long essay cannot end up with an unmanageable pile of cards. */
export const MAX_CARDS = 12;

/**
 * How long after a card opens, a second click on the same word is treated as a
 * repeat of the first rather than a request to close it. A deliberate close
 * comes later than this; an impatient double tap comes sooner.
 */
const TOGGLE_GUARD_MS = 900;

/** token id -> { el, anchor, key, ready } */
const cards = new Map();
let layer = null;
let zCounter = 40;
let tokenSeq = 0;
let onCountChange = () => {};

/** Give every word token a unique id so the same word can be pinned twice. */
export function assignTokenIds(scope) {
  for (const el of scope.querySelectorAll('.w')) {
    tokenSeq += 1;
    el.dataset.id = String(tokenSeq);
  }
}

/* ------------------------------------------------------------- card content */

const GLOSS_SEP = /[\s,，;；、.。:：()（）/]/;

/** Split one gloss line into its individual Chinese terms. */
function glossTerms(text) {
  return String(text)
    .split(GLOSS_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Drop gloss lines that say the same thing twice.
 *
 * The dictionary sometimes yields two parallel entry sets for one word. When
 * they merely restate the same terms (or one is a subset of the other) only the
 * first is kept. When they genuinely differ — a learner sense plus a legal
 * sense, say — both stay, because hiding a real meaning would be worse than a
 * slightly longer card.
 *
 * The rule is intentionally conservative; an overlap-percentage heuristic was
 * tried and rejected because it folded distinct words such as 苹果 / 苹果树
 * into each other. `tools/check-dedupe.mjs` pins the behaviour down.
 */
function dedupeGlosses(glosses) {
  const kept = [];
  for (const g of glosses) {
    const text = String(g.text || '').trim();
    if (!text) continue;

    const mine = new Set(glossTerms(text));
    const duplicate = kept.some((prev) => {
      if (prev.text === text) return true;
      const theirs = new Set(glossTerms(prev.text));
      const mineInsideTheirs = [...mine].every((x) => theirs.has(x));
      const theirsInsideMine = [...theirs].every((x) => mine.has(x));
      return mineInsideTheirs || theirsInsideMine;
    });

    if (!duplicate) kept.push({ ...g, text });
  }
  return kept;
}

function glossList(entry) {
  const glosses = dedupeGlosses(entry.glosses || []);
  if (!glosses.length) {
    return `<p class="card__empty">${escapeHtml(t('card.noMeaning'))}</p>`;
  }
  return (
    `<ul class="card__glosses">` +
    glosses
      .map(
        (g) =>
          `<li>` +
          (g.pos ? `<span class="card__pos">${escapeHtml(g.pos)}</span>` : '') +
          `<span class="card__zh">${escapeHtml(g.text)}</span>` +
          `</li>`,
      )
      .join('') +
    `</ul>`
  );
}

/**
 * How much extra material to show around the glosses.
 *
 * The reader asked for cards that follow their content: a word with one sense
 * should get a small card. The glosses themselves are always shown in full —
 * they are the answer. What scales is everything else: a small entry gets no
 * phrase list and at most one example, a rich entry gets a few of each. The
 * full entry is still reachable through scroll when the card overflows.
 */
function extrasBudget(entry) {
  const senses = dedupeGlosses(entry.glosses || []).length;
  if (senses <= 1) return { phrases: 0, examples: 1 };
  if (senses === 2) return { phrases: 2, examples: 1 };
  return { phrases: 4, examples: 2 };
}

function detailSections(entry) {
  const parts = [];
  const budget = extrasBudget(entry);

  if (entry.exam?.length) {
    parts.push(`<p class="card__tags">${entry.exam.map((tag) => `<i>${escapeHtml(tag)}</i>`).join('')}</p>`);
  }

  if (entry.phrases?.length && budget.phrases > 0) {
    parts.push(
      `<div class="card__block"><h4>${escapeHtml(t('card.phrases'))}</h4>` +
        entry.phrases
          .slice(0, budget.phrases)
          .map((p) => `<p class="card__line"><b>${escapeHtml(p.text)}</b> ${escapeHtml(p.translation)}</p>`)
          .join('') +
        `</div>`,
    );
  }

  if (entry.collins?.length && !entry.glosses?.length) {
    parts.push(
      `<div class="card__block"><h4>${escapeHtml(t('card.dictionaryLine'))}</h4>` +
        entry.collins.slice(0, 2).map((l) => `<p class="card__zh">${escapeHtml(l)}</p>`).join('') +
        `</div>`,
    );
  }

  if (entry.examples?.length && budget.examples > 0) {
    parts.push(
      `<div class="card__block"><h4>${escapeHtml(t('card.sentence'))}</h4>` +
        entry.examples
          .slice(0, budget.examples)
          .map(
            (e) =>
              `<p class="card__ex">${escapeHtml(e.en)}</p>` +
              `<p class="card__ex card__ex--zh">${escapeHtml(e.zh)}</p>`,
          )
          .join('') +
        `</div>`,
    );
  }

  if (entry.matchedFrom) {
    parts.push(`<p class="card__note">${escapeHtml(t('card.baseForm', { word: entry.matchedFrom }))}</p>`);
  }
  if (entry.source === 'glossary') {
    parts.push(
      `<p class="card__note">${escapeHtml(t('card.fallback'))}</p>`,
    );
  }

  return parts.join('');
}

function cardHeader(entry, raw) {
  const ipa = entry.phonetics?.us || entry.phonetics?.uk || '';
  return (
    `<header class="card__head">` +
    `<button type="button" class="card__close" title="${escapeHtml(t('card.close'))}" aria-label="${escapeHtml(t('card.close'))}">✕</button>` +
    `<span class="card__word">${escapeHtml(raw || entry.word)}</span>` +
    (ipa ? `<span class="card__ipa">/${escapeHtml(ipa)}/</span>` : '') +
    `<span class="card__spacer"></span>` +
    `<button type="button" class="card__speak" title="${escapeHtml(t('card.hear'))}" aria-label="${escapeHtml(t('card.hear'))}">🔊</button>` +
    `</header>`
  );
}

/* ------------------------------------------------------------ positioning  */

/**
 * Bottom edge of everything sticky that renders above the card layer.
 *
 * The top bar and the reading toolbar are `position: sticky` at higher
 * z-indexes than the cards. A card whose top slid under them would have its ✕
 * covered by an element the tap cannot reach — the reader taps the ✕ and
 * actually hits the toolbar, which looks exactly like a dead button.
 */
function stickyBarsBottom() {
  let bottom = 0;
  for (const sel of ['.topbar', '.reader__toolbar']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > bottom) bottom = r.bottom;
  }
  return bottom;
}

/**
 * Place the card beside its word. Coordinates are document-based, so the card
 * travels with the page instead of floating away when the user scrolls.
 *
 * Two rules keep the ✕ where the finger expects it:
 *
 * 1. The side (above/below) is decided ONCE, when the card opens, and reused
 *    for every later placement, so a growing card never flips to the other
 *    side of the word mid-read.
 *
 * 2. The top edge never goes above the sticky bars. A card placed higher than
 *    that is a card whose ✕ cannot be tapped at all.
 *
 * The card sizes itself to its content (the CSS caps it at 70% of the
 * viewport), so a two-sense word gets a small card and a ten-sense word gets a
 * tall one, as the reader expects.
 *
 * @param {HTMLElement} el
 * @param {HTMLElement} anchor
 * @param {'below'|'above'|undefined} side  omit to keep the current choice
 */
function place(el, anchor, side) {
  const rect = anchor.getBoundingClientRect();
  const gap = 8;
  const width = el.offsetWidth || 280;

  let left = rect.left + window.scrollX + rect.width / 2 - width / 2;
  const minLeft = window.scrollX + 12;
  const maxLeft = window.scrollX + window.innerWidth - width - 12;
  left = Math.max(minLeft, Math.min(left, Math.max(minLeft, maxLeft)));

  const stickyBottom = stickyBarsBottom();

  let chosen = side || el.dataset.side;
  if (!chosen) {
    // Estimate with the card's eventual height rather than its current strip:
    // an empty "looking up…" card always fits, which would make every card
    // open downward and then overgrow past the bottom of the screen.
    const estimated = estimateCardHeight(el);
    const belowRoom = window.innerHeight - rect.bottom - gap;
    const aboveRoom = rect.top - stickyBottom - gap;
    chosen = belowRoom >= estimated || aboveRoom < estimated ? 'below' : 'above';
    el.dataset.side = chosen;
  }

  const top =
    chosen === 'above'
      ? rect.top + window.scrollY - el.offsetHeight - gap
      : rect.bottom + window.scrollY + gap;

  // The floor: the card must start below the sticky bars, or its ✕ disappears
  // under them. When this clamps, the card overlaps the word instead — an
  // eyesore, but one whose close button still works.
  const clampedTop = Math.max(window.scrollY + stickyBottom + 8, top);

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(clampedTop)}px`;
}

/**
 * Guess the finished card's height before the entry arrives, so the side can be
 * chosen correctly on the first placement. Broadly: header, each sense, each
 * phrase, each example. It only needs to be close — the purpose is choosing a
 * side, not laying out the card.
 */
function estimateCardHeight(el) {
  const key = el.dataset.key || '';
  const word = key.length;
  // Rough model, tuned against a few real entries: the loading strip is ~64px,
  // and every additional sense/phrase/example adds roughly a text line.
  const senses = Math.min(8, 2 + Math.floor(word / 4));
  const lines = 2 + senses;
  return Math.min(window.innerHeight * 0.7, 64 + lines * 30);
}

/* ------------------------------------------------------------ card actions */

/** Voices are loaded asynchronously on Android; cache the best English one. */
let cachedVoice = null;
let voicesReady = false;

function pickEnglishVoice() {
  if (cachedVoice) return cachedVoice;
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  // Prefer an explicit en-US voice, then any English one. Without this some
  // Android engines fall back to the system default voice, which may be a
  // Chinese one and reads the word with the wrong phonology or in silence.
  cachedVoice =
    voices.find((v) => /^en[-_]US/i.test(v.lang) && v.localService) ||
    voices.find((v) => /^en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en[-_]/i.test(v.lang)) ||
    null;
  return cachedVoice;
}

if ('speechSynthesis' in window) {
  // Chromium fills getVoices() on a later tick, and takes the voices away again
  // on some Android builds. Re-resolve whenever the list changes.
  const onVoices = () => { cachedVoice = null; voicesReady = true; pickEnglishVoice(); };
  window.speechSynthesis.addEventListener?.('voiceschanged', onVoices);
  onVoices();
}

/**
 * Speak one entry's word.
 *
 * Must be called synchronously from a user gesture: iOS Safari, and WeChat's
 * embedded engine, refuse to start speech otherwise. Everything here is
 * synchronous on purpose — no awaits before `speak()`.
 *
 * Exported because the saved-words panel speaks too, and both should share the
 * same voice selection and failure reporting.
 *
 * @returns {'ok'|'unsupported'|'failed'|'silent'} a status for the caller to
 *   report, so the button is never silently inert.
 */
export function speak(entry) {
  const word = String(entry?.word || '').trim();
  if (!word) return 'failed';
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    return 'unsupported';
  }

  try {
    const synth = window.speechSynthesis;
    // A stuck-chrome quirk: a synthesiser left paused stays silent forever.
    if (synth.paused) synth.resume();
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    utterance.pitch = 1;
    utterance.volume = 1;
    const voice = pickEnglishVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    let spoke = false;
    let failed = false;
    utterance.onstart = () => { spoke = true; };
    utterance.onerror = () => { failed = true; };

    synth.speak(utterance);

    // Some embedded engines accept `speak()` and then do nothing at all, with
    // no error event. Report that rather than leave the reader guessing.
    if (!spoke && !failed && !voicesReady && !synth.speaking && !synth.pending) {
      return 'silent';
    }
    return 'ok';
  } catch {
    return 'failed';
  }
}

/**
 * Tell the reader what happened when they tap 🔊, and show a pressed state on
 * the button so the tap is visibly acknowledged even before audio starts.
 */
function announceSpeakResult(status, cardEl) {
  const btn = cardEl?.querySelector('.card__speak');
  if (btn) {
    btn.classList.add('card__speak--active');
    setTimeout(() => btn.classList.remove('card__speak--active'), 320);
  }
  document.dispatchEvent(new CustomEvent('card:spoke', { detail: { status } }));
}

/** Move an existing card to the front of the stack. */
function raise(el) {
  el.style.zIndex = String((zCounter += 1));
  el.classList.remove('card--flash');
  // Force a reflow so the animation restarts on repeated clicks.
  void el.offsetWidth;
  el.classList.add('card--flash');
}

/**
 * Draw a finished card: header plus body, in the one correct structure.
 *
 * Both the first render and the later enrichment go through here, which is what
 * keeps a header from being nested inside a body when the richer entry arrives.
 */
function paintCard(el, entry, raw) {
  el.__entry = entry;
  el.innerHTML =
    cardHeader(entry, raw) +
    `<div class="card__body">${glossList(entry)}${detailSections(entry)}</div>`;
  el.classList.add('card--ready');
}

async function fillCard(el, anchor, raw, key, essayId) {
  const result = await lookup(key, {
    // A desktop proxy, when present, adds phrases and example sentences. The
    // card repaints itself in place; the meaning already shown never vanishes.
    onEnrich: (rich) => {
      if (!cards.has(el.dataset.id)) return;
      if (el.dataset.enriched === '1') return;
      el.dataset.enriched = '1';
      paintCard(el, rich, raw);
      state.recordWord({ key, raw, entry: rich });
      place(el, anchor);
    },
  });

  const emptyEntry = { word: key, glosses: [], phonetics: { us: '', uk: '' }, phrases: [], examples: [], source: 'none' };

  /*
   * The dictionary is still downloading and this word lives in a chunk that has
   * not arrived yet.
   *
   * On a slow connection the six chunks can take half a minute. Saying "no such
   * word" during that window is not just unhelpful, it is wrong — and a reader
   * who is told that a perfectly ordinary word does not exist concludes the app
   * is broken and taps it again. So the card stays open, says it is still
   * looking, and fills itself in the moment the chunks land.
   */
  if (result?.pending) {
    if (!cards.has(el.dataset.id)) return;
    el.innerHTML =
      cardHeader({ word: key, phonetics: {} }, raw) +
      `<div class="card__body">` +
      `<p class="card__loading">${escapeHtml(t('card.loading', { word: raw }))}</p>` +
      `<p class="card__note">${escapeHtml(t('card.loadingDictionary'))}</p>` +
      `</div>`;
    el.classList.add('card--ready');
    place(el, anchor);

    const late = await awaitDictionary().then(() => lookup(key));
    const lateEntry = late?.entry || emptyEntry;
    state.recordWord({ key, raw, entry: lateEntry });
    state.markSeen(essayId, key);
    anchor.classList.add('w--seen');
    if (!cards.has(el.dataset.id)) return; // closed while the dictionary loaded
    paintCard(el, lateEntry, raw);
    place(el, anchor);
    raise(el);
    return;
  }

  if (!cards.has(el.dataset.id)) return; // closed while loading

  // If enrichment already painted the richer card, leave it alone.
  if (el.dataset.enriched === '1') return;

  const entry = result?.entry || emptyEntry;

  paintCard(el, entry, raw);

  place(el, anchor);
  raise(el);

  // Every looked-up word is recorded, so the Saved Words list is automatic.
  state.recordWord({ key, raw, entry });
  state.markSeen(essayId, key);
  anchor.classList.add('w--seen');
}

/** Open a pinned card for one word token. */
function openCard(anchor, essayId) {
  const key = anchor.dataset.w;
  if (!key) return null;

  const id = anchor.dataset.id || (anchor.dataset.id = String((tokenSeq += 1)));
  if (cards.has(id)) {
    raise(cards.get(id).el);
    return cards.get(id);
  }
  if (cards.size >= MAX_CARDS) return 'full';

  const raw = anchor.dataset.raw || key;
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = id;
  el.dataset.key = key;

  /*
   * Closing: three mechanisms cover every mobile browser quirk.
   *
   * 1. `click` — the standard path. Works everywhere except a few embedded
   *    browsers (WeChat, some Android WebViews) that intermittently swallow
   *    synthesized clicks on dynamically added elements.
   *
   * 2. `pointerup` — fires before the click on every modern browser, and in the
   *    broken ones still arrives reliably. Running the close here is what makes
   *    the ✕ respond on the first tap in WeChat. The click that follows (when it
   *    does) finds the card already gone, which is harmless.
   *
   * 3. `touchend` — the deepest fallback, for the rare engine that emits touch
   *    events but never completes the pointer chain. Debounced by the card's
   *    `closedAt` stamp so the three mechanisms cannot double-run.
   *
   * The whole header closes the card — word, phonetics, spare space, either
   * button — because it is far larger than the ✕ alone. Only 🔊 speaks instead.
   */
  const requestClose = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const record = cards.get(id);
    if (!record) return;
    if (record.closedAt && Date.now() - record.closedAt < 250) return;
    record.closedAt = Date.now();
    closeCard(id);
  };

  /*
   * Which taps close the card, and which speak.
   *
   * The header is the close target — it is far larger than the ✕ — but the 🔊
   * button lives inside it and must NOT close the card. An earlier version
   * matched the whole header in every handler, which meant pointerup fired
   * first, removed the card, and the 🔊 tap never reached its own handler: the
   * button looked dead.
   *
   * All three handlers are registered because a card is a dynamically added
   * element, and some embedded browsers (WeChat, several Android WebViews)
   * intermittently drop the synthesized click. Each path is debounced by a
   * timestamp on the card record, so one tap cannot fire twice.
   */
  const isSpeakArea = (ev) =>
    !!(ev.target.closest && ev.target.closest('.card__speak'));

  const isCloseArea = (ev) =>
    !!(ev.target.closest && ev.target.closest('.card__head'));

  /** Speak once per tap, whichever handler gets there first. */
  const requestSpeak = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const record = cards.get(id);
    if (!record) return;
    if (record.spokenAt && Date.now() - record.spokenAt < 400) return;
    record.spokenAt = Date.now();
    // Called synchronously inside the gesture: iOS and WeChat require it.
    announceSpeakResult(speak(el.__entry), el);
  };

  el.addEventListener('click', (ev) => {
    if (isSpeakArea(ev)) {
      requestSpeak(ev);
      return;
    }
    if (isCloseArea(ev)) requestClose(ev);
  });

  // Mechanism 2: fires reliably even where the synthesized click is dropped.
  el.addEventListener('pointerup', (ev) => {
    if (ev.pointerType === 'mouse') return; // the click path already covers it
    if (isSpeakArea(ev)) {
      requestSpeak(ev);
      return;
    }
    if (isCloseArea(ev)) requestClose(ev);
  });

  // Mechanism 3: last resort for engines that never finish the pointer chain.
  el.addEventListener('touchend', (ev) => {
    if (isSpeakArea(ev)) {
      requestSpeak(ev);
      return;
    }
    if (isCloseArea(ev)) {
      const record = cards.get(id);
      if (record && record.closedAt && Date.now() - record.closedAt < 250) return;
      ev.preventDefault();
      closeCard(id);
    }
  });

  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<div class="card__body"><p class="card__loading">${escapeHtml(t('card.loading', { word: raw }))}</p></div>`;

  // Two cards can overlap. Touching any part of a card brings it to the front,
  // so its close button is always reachable.
  el.addEventListener('pointerdown', () => raise(el));

  layer.appendChild(el);
  place(el, anchor);
  el.style.zIndex = String((zCounter += 1));

  const record = { el, anchor, key, essayId, openedAt: Date.now() };
  cards.set(id, record);
  anchor.classList.add('w--open');
  onCountChange(cards.size);

  fillCard(el, anchor, raw, key, essayId);
  return record;
}

/** Close one card by token id. Only called from user action. */
export function closeCard(id) {
  const record = cards.get(id);
  if (!record) return false;
  record.closedAt = Date.now();
  record.el.remove();
  record.anchor.classList.remove('w--open');
  cards.delete(id);
  onCountChange(cards.size);
  return true;
}

/** Close every card — used when switching essays, and by the Close-all button. */
export function closeAll() {
  for (const id of [...cards.keys()]) closeCard(id);
}

export function cardCount() {
  return cards.size;
}

/**
 * Hide or show the card layer without destroying any card. Switching to the
 * Saved Words view must not erase meanings the user pinned, so the cards are
 * kept and simply hidden until the essay is on screen again.
 */
export function setLayerVisible(visible) {
  if (!layer) return;
  layer.style.display = visible ? '' : 'none';
  if (visible) {
    for (const { el, anchor } of cards.values()) {
      if (!el.classList.contains('card--free') && document.contains(anchor)) place(el, anchor);
    }
  }
}

/**
 * The single entry point for a click on a word.
 *
 * Clicking a word opens its card. Clicking the same word again closes it — but
 * only if that second click is deliberate. On a phone a reader who thinks the
 * first tap was ignored taps again within a fraction of a second, and closing
 * the card at that moment is the worst possible response: it makes a working
 * tap look like a dead one and forces yet another tap.
 *
 * So a click that arrives while the card is still settling (or very shortly
 * after it opened) is treated as a repeat of the original tap and simply keeps
 * the card open. This is the `TOGGLE_GUARD_MS` window.
 *
 * @returns {'opened'|'closed'|'kept'|'full'|'ignored'}
 */
export function toggleWord(anchor, essayId) {
  if (!anchor?.classList?.contains('w')) return 'ignored';
  const id = anchor.dataset.id;

  if (id && cards.has(id)) {
    const record = cards.get(id);
    const age = Date.now() - (record.openedAt || 0);
    if (age < TOGGLE_GUARD_MS) {
      // A second tap in quick succession: assume the reader still wants it.
      raise(record.el);
      return 'kept';
    }
    closeCard(id);
    return 'closed';
  }

  return openCard(anchor, essayId) === 'full' ? 'full' : 'opened';
}

/** True if the given word currently has at least one open card. */
export function hasOpenCardForKey(key) {
  for (const { el } of cards.values()) if (el.dataset.key === key) return true;
  return false;
}

/**
 * After the essay re-renders (font size, cleared wordbook), keep every card
 * attached to its own word. A card is never destroyed here: a re-render must
 * not erase a meaning the user pinned. If the exact token is gone, the card
 * takes over the first free token with the same word, and falls back to
 * staying where it is if no token matches.
 */
export function rebind(scope) {
  const tokens = [...scope.querySelectorAll('.w')];
  const claimed = new Set();

  // Pass 1: anchors that survived the re-render keep their own token.
  for (const record of cards.values()) {
    if (tokens.includes(record.anchor)) {
      record.anchor.classList.add('w--open');
      record.anchor.dataset.id = record.el.dataset.id;
      claimed.add(record.anchor);
    }
  }

  // Pass 2: anchors that vanished get re-pointed at the first free same-word
  // token that no surviving card already owns.
  for (const record of cards.values()) {
    if (claimed.has(record.anchor)) continue;
    const next = tokens.find((token) => token.dataset.w === record.key && !claimed.has(token));
    if (next) {
      next.dataset.id = record.el.dataset.id;
      next.classList.add('w--open');
      record.anchor = next;
      claimed.add(next);
      delete record.el.dataset.free;
      record.el.classList.remove('card--free');
    } else {
      record.el.classList.add('card--free');
    }
  }

  for (const { el, anchor } of cards.values()) {
    if (!el.classList.contains('card--free')) place(el, anchor);
  }
  onCountChange(cards.size);
}

/** Mount the card layer once. */
export function initPinLayer(root = document.body, countHandler) {
  if (typeof countHandler === 'function') onCountChange = countHandler;
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'card-layer';
  root.appendChild(layer);
  window.addEventListener('resize', () => {
    for (const { el, anchor } of cards.values()) {
      if (document.contains(anchor) && !el.classList.contains('card--free')) place(el, anchor);
    }
  });
  return layer;
}
