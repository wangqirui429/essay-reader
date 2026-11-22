/**
 * Essay Reader front-end controller.
 *
 * Views: home (import + list of imported essays), reader (the essay with
 * clickable words), saved words, settings. Routing is by hash so the back
 * button behaves normally.
 */

import * as state from './state.js';
import { initLang, getLang, setLang, t, applyStaticTranslations } from './i18n.js';
import { splitParas, tokenizeParagraph, countWords, excerpt, escapeHtml } from './tokenize.js';
import { initPinLayer, toggleWord, closeAll, cardCount, assignTokenIds, rebind, setLayerVisible, MAX_CARDS, speak } from './pin.js';
import { lookup, warmUp, prepareEssay, dictionaryStatus } from './dict.js';
import { initAccount, refreshAccountPanel } from './account.js';
import { adoptRecoverySession } from './auth.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ui = {
  main: $('#main'),
  shelf: $('#shelf'),
  shelfCount: $('#shelfCount'),
  essayBody: $('#essayBody'),
  essayTitle: $('#essayTitle'),
  essayMeta: $('#essayMeta'),
  openCount: $('#openCount'),
  seenLabel: $('#seenLabel'),
  wordList: $('#wordList'),
  wordsCount: $('#wordsCount'),
  wordsEmpty: $('#wordsEmpty'),
  toast: $('#toast'),
  impStatus: $('#impStatus'),
};

let activeEssayId = null;
let toastTimer = null;

/* ------------------------------------------------------------------- utils */

function toast(message, ms = 2600) {
  ui.toast.textContent = message;
  ui.toast.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('toast--show'), ms);
}

/**
 * Explain a speech failure instead of leaving a dead-looking button.
 *
 * Pronunciation depends on the device having an English voice installed, which
 * a phone set to Chinese may not have — and some embedded browsers expose the
 * API but never emit audio. Both cases are reported to the reader.
 *
 * @param {'ok'|'unsupported'|'failed'|'silent'} status from speak()
 */
function announceSpeakFailure(status) {
  if (!status || status === 'ok') return;
  const key =
    status === 'unsupported'
      ? 'speak.unsupported'
      : status === 'silent'
        ? 'speak.silent'
        : 'speak.failed';
  toast(t(key), 4200);
}

// The card's 🔊 reports through an event, because the card module does not own
// the toast.
document.addEventListener('card:spoke', (ev) => announceSpeakFailure(ev.detail?.status));

/**
 * Dates follow the interface language rather than the browser locale.
 *
 * Pinning the locale is deliberate: on an English interface a Chinese-language
 * browser would otherwise print "2026年11月19日", and on a Chinese interface an
 * English browser would print "19 Nov 2026" — neither matches the surrounding
 * text.
 */
const dateLocale = () => (getLang() === 'en' ? 'en-GB' : 'zh-CN');

const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });

const fmtDateTime = (ts) =>
  new Date(ts).toLocaleString(dateLocale(), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function makeId(title, text) {
  const seed = String(title || text || 'essay')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let id = seed || `essay-${Date.now().toString(36)}`;
  let n = 2;
  while (state.getEssay(id)) id = `${seed}-${(n += 1)}`;
  return id;
}

/* ------------------------------------------------------------------- views */

function showView(name) {
  document.body.dataset.view = name;
  for (const panel of $$('.view')) {
    panel.hidden = panel.dataset.viewPanel !== name;
  }
  for (const link of $$('.nav a')) {
    link.classList.toggle('is-active', link.dataset.nav === name);
  }
  updateOpenBadge(name);
}

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('words')) return 'words';
  if (hash.startsWith('settings')) return 'settings';
  if (hash.startsWith('read/')) return 'reader';
  return 'home';
}

/* -------------------------------------------------------------------- home */

function essayTile(essay) {
  const el = document.createElement('article');
  el.className = 'tile';
  el.dataset.id = essay.id;
  const seen = (state.getState().seen[essay.id] || []).length;
  el.innerHTML =
    `<h3 class="tile__title">${escapeHtml(essay.title)}</h3>` +
    `<p class="tile__meta">${t('tile.words', { n: essay.words })} · ${t('tile.paragraphs', { n: essay.paragraphs || '?' })}${seen ? ` · ${t('tile.lookedUp', { n: seen })}` : ''}</p>` +
    `<p class="tile__excerpt">${escapeHtml(excerpt(essay.text))}</p>` +
    `<div class="tile__foot">` +
    `<button class="btn btn--primary btn--sm" data-act="open" type="button">${escapeHtml(t('tile.read'))}</button>` +
    `<button class="btn btn--ghost btn--sm" data-act="rename" type="button">${escapeHtml(t('tile.rename'))}</button>` +
    `<button class="btn btn--danger btn--sm" data-act="delete" type="button">${escapeHtml(t('tile.delete'))}</button>` +
    `<span class="tile__date">${fmtDate(essay.addedAt || Date.now())}</span>` +
    `</div>`;
  return el;
}

function renderShelf() {
  const essays = state.listEssays();
  ui.shelf.innerHTML = '';
  ui.shelfCount.textContent = essays.length ? `(${essays.length})` : '';

  if (!essays.length) {
    const empty = document.createElement('p');
    empty.className = 'shelf__empty';
    empty.textContent = t('home.empty');
    ui.shelf.appendChild(empty);
    return;
  }
  for (const essay of essays) ui.shelf.appendChild(essayTile(essay));
}

ui.shelf.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.tile').dataset.id;
  const essay = state.getEssay(id);
  if (!essay) return;

  if (btn.dataset.act === 'open') {
    location.hash = `#/read/${id}`;
  } else if (btn.dataset.act === 'rename') {
    const next = window.prompt(t('tile.renamePrompt'), essay.title);
    if (next && next.trim()) {
      state.putEssay({ ...essay, title: next.trim().slice(0, 80) });
      renderShelf();
    }
  } else if (btn.dataset.act === 'delete') {
    if (window.confirm(t('tile.confirmDelete', { title: essay.title }))) {
      state.deleteEssay(id);
      closeAll();
      renderShelf();
      toast(t('tile.deleted'));
    }
  }
});

/** Add pasted/typed text as an essay, then open it. */
function importText(text, titleHint = '') {
  const clean = String(text).replace(/\r\n?/g, '\n').trim();
  if (clean.split(/\s+/).length < 15) {
    ui.impStatus.textContent = t('home.tooShort');
    return false;
  }
  const { heading, paragraphs } = splitParas(clean);
  const title = (titleHint || heading || paragraphs[0]?.split(/[.!?]/)[0].slice(0, 54) || t('home.untitled')).trim();
  const essay = state.putEssay({
    id: makeId(title, clean),
    title: title.slice(0, 80),
    text: clean,
    words: countWords(clean),
    paragraphs: paragraphs.length,
    source: 'pasted',
  });
  ui.impStatus.textContent = '';
  $('#impText').value = '';
  $('#impTitle').value = '';
  renderShelf();
  location.hash = `#/read/${essay.id}`;
  return true;
}

$('#impSave').addEventListener('click', () => importText($('#impText').value, $('#impTitle').value));
$('#impTitle').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') importText($('#impText').value, $('#impTitle').value);
});

function readFiles(files) {
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.json')) {
      // The parameter is named `content`, not `t`: `t` is the translation
      // function, and shadowing it would break both the import and the message.
      file.text().then((content) => {
        const err = state.importJson(content);
        toast(err || t('settings.backupRestored'));
        if (!err) { renderShelf(); renderWords(); }
      });
      continue;
    }
    file.text().then((content) => {
      if (!importText(content, file.name.replace(/\.(txt|md)$/i, ''))) {
        toast(t('home.fileTooShort', { name: file.name }));
      }
    });
  }
}

$('#impFile').addEventListener('change', (ev) => readFiles([...ev.target.files]));

/**
 * One-click import of the bundled sample essay, so a new reader has something
 * real to open before they paste their own text.
 */
async function loadSampleEssay() {
  const btn = $('#impSample');
  btn.disabled = true;
  ui.impStatus.textContent = t('home.loadingSample');
  try {
    const res = await fetch('./samples/a-hanging.txt', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    ui.impStatus.textContent = '';
    importText(text, 'A Hanging — George Orwell (1931)');
    toast(t('home.sampleLoaded'));
  } catch (err) {
    ui.impStatus.textContent = t('home.sampleFailed', { msg: err.message });
  } finally {
    btn.disabled = false;
  }
}

$('#impSample').addEventListener('click', loadSampleEssay);

const dropzone = $('#dropzone');
window.addEventListener('dragover', (ev) => {
  if (currentRoute() !== 'home') return;
  ev.preventDefault();
  dropzone.classList.add('dropzone--over');
});
window.addEventListener('dragleave', () => dropzone.classList.remove('dropzone--over'));
window.addEventListener('drop', (ev) => {
  if (currentRoute() !== 'home' || !ev.dataTransfer?.files?.length) return;
  ev.preventDefault();
  dropzone.classList.remove('dropzone--over');
  readFiles([...ev.dataTransfer.files]);
});

/* ------------------------------------------------------------------ reader */

function renderEssay(essay) {
  const { heading, paragraphs } = splitParas(essay.text);
  const seen = state.seenKeysFor(essay.id);

  ui.essayTitle.textContent = heading && heading.length <= 70 ? heading : essay.title;
  ui.essayMeta.textContent = t('reader.meta', { words: essay.words, paras: paragraphs.length, date: fmtDate(essay.addedAt || Date.now()) });

  ui.essayBody.innerHTML = paragraphs
    .map((p, i) => `<p class="para" data-idx="${i}">${tokenizeParagraph(p, { seenKeys: seen })}</p>`)
    .join('');

  assignTokenIds(ui.essayBody);
  ui.seenLabel.textContent = t('reader.seen', { n: seen.size });
}

function openEssay(id) {
  const essay = state.getEssay(id);
  if (!essay) {
    location.hash = '#/';
    return;
  }
  // Coming back to the same essay must not erase pinned meanings.
  if (id === activeEssayId && cardCount() > 0 && ui.essayBody.childElementCount > 0) {
    showView('reader');
    setLayerVisible(true);
    return;
  }
  activeEssayId = id;
  state.setCurrent(id);
  closeAll();
  showView('reader');
  setLayerVisible(true);
  renderEssay(essay);
  document.documentElement.style.setProperty('--para-size', `${state.getSetting('fontSize')}px`);
  applyMeasure();
  window.scrollTo(0, 0);
  prepareForEssay(essay);
}

/**
 * Warm the dictionary for the essay being opened: load the shards its harder
 * words live in, so the first tap on an unusual word does not wait.
 */
function prepareForEssay(essay) {
  prepareEssay(essay.text);
}

ui.essayBody.addEventListener('click', (ev) => {
  const anchor = ev.target.closest('.w');
  if (!anchor) return;
  ev.preventDefault();
  const result = toggleWord(anchor, activeEssayId);
  if (result === 'full') {
    toast(t('reader.tooManyCards', { n: MAX_CARDS }));
    return;
  }
  if (result === 'ignored') return;
  updateOpenBadge();
  if (result === 'opened') {
    const n = state.seenKeysFor(activeEssayId).size;
    ui.seenLabel.textContent = t('reader.seen', { n });
  }
});

/** Keyboard access: a focused word answers Enter or Space like a click. */
ui.essayBody.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const anchor = ev.target.closest('.w');
  if (!anchor) return;
  ev.preventDefault();
  toggleWord(anchor, activeEssayId);
  updateOpenBadge();
});

function updateOpenBadge(name = currentRoute()) {
  const n = cardCount();
  ui.openCount.hidden = name !== 'reader' || n === 0;
  ui.openCount.textContent = t('reader.cardsOpen', { n });
}

$('#btnClearCards').addEventListener('click', () => {
  closeAll();
  updateOpenBadge();
  toast(t('reader.allClosed'));
});

$('#btnSizeUp').addEventListener('click', () => changeSize(1));
$('#btnSizeDown').addEventListener('click', () => changeSize(-1));

function changeSize(delta) {
  const size = Math.max(16, Math.min(26, state.getSetting('fontSize') + delta));
  state.setSetting('fontSize', size);
  document.documentElement.style.setProperty('--para-size', `${size}px`);
  syncSizeControls();
  rebind(ui.essayBody);
}

function syncSizeControls() {
  const size = state.getSetting('fontSize');
  $('#sizeValue').textContent = `${size} px`;
  $('#sizeRange').value = String(size);
}

function applyMeasure() {
  document.documentElement.style.setProperty('--measure', state.getSetting('measure') ? '46rem' : '72rem');
}

/* -------------------------------------------------------------- saved words */

function wordRow(word) {
  const el = document.createElement('li');
  el.className = 'wrow';
  const ipa = word.phonetics?.us || word.phonetics?.uk || '';
  const glosses = (word.glosses || [])
    .slice(0, 3)
    .map((g) => `<span class="wrow__pos">${escapeHtml(g.pos)}</span>${escapeHtml(g.text)}`)
    .join(' · ');
  el.innerHTML =
    `<div class="wrow__main">` +
    `<div class="wrow__head"><b class="wrow__word">${escapeHtml(word.raw)}</b>` +
    (ipa ? `<span class="wrow__ipa">/${escapeHtml(ipa)}/</span>` : '') +
    `<span class="wrow__hits">${escapeHtml(t('words.lookups', { n: word.hits }))}</span></div>` +
    `<p class="wrow__zh">${glosses || `<i>${escapeHtml(t('words.noMeaning'))}</i>`}</p>` +
    `<p class="wrow__time">${escapeHtml(fmtDateTime(word.lastAt || word.firstAt))}</p>` +
    `</div>` +
    `<div class="wrow__actions">` +
    `<button class="btn btn--ghost btn--xs" data-act="speak" type="button" title="${escapeHtml(t('words.hear'))}">🔊</button>` +
    `<button class="btn btn--danger btn--xs" data-act="forget" type="button" title="${escapeHtml(t('words.remove'))}">${escapeHtml(t('words.remove'))}</button>` +
    `</div>`;
  el.dataset.key = word.key;
  return el;
}

function renderWords(filter = '') {
  const all = state.listWords();
  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? all.filter(
        (w) =>
          w.key.includes(needle) ||
          (w.glosses || []).some((g) => g.text.toLowerCase().includes(needle)),
      )
    : all;

  ui.wordList.innerHTML = '';
  for (const word of rows) ui.wordList.appendChild(wordRow(word));
  ui.wordsCount.textContent = t('words.count', { shown: rows.length, total: all.length });
  ui.wordsEmpty.hidden = all.length > 0;
  if (all.length && !rows.length) {
    ui.wordsEmpty.hidden = false;
    ui.wordsEmpty.textContent = t('words.noMatch', { q: filter });
  } else if (!all.length) {
    ui.wordsEmpty.textContent = t('words.empty');
  }
}

$('#wordSearch').addEventListener('input', (ev) => renderWords(ev.target.value));

ui.wordList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const key = btn.closest('.wrow').dataset.key;
  const word = state.getWord(key);
  if (!word) return;
  if (btn.dataset.act === 'forget') {
    state.forgetWord(key);
    renderWords($('#wordSearch').value);
    toast(t('words.removed', { word: word.raw }));
  } else if (btn.dataset.act === 'speak') {
    // Shared with the card's 🔊, so both use the same voice selection and
    // report the same failures on a device with no English voice installed.
    announceSpeakFailure(speak({ word: word.raw || word.key }));
  }
});

$('#btnWordsClear').addEventListener('click', () => {
  if (!state.listWords().length) return toast(t('words.alreadyEmpty'));
  if (window.confirm(t('words.confirmClear'))) {
    state.clearWords();
    renderWords();
    if (activeEssayId) renderEssay(state.getEssay(activeEssayId));
    toast(t('words.cleared'));
  }
});

$('#btnWordsCsv').addEventListener('click', () => {
  const rows = [['word', 'phonetic', 'meaning']];
  for (const w of state.listWords()) {
    const meaning = (w.glosses || []).map((g) => `${g.pos} ${g.text}`).join(' | ');
    rows.push([w.raw || w.key, w.phonetics?.us || w.phonetics?.uk || '', meaning]);
  }
  const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download('saved-words.csv', csv, 'text/csv;charset=utf-8');
});

/* ---------------------------------------------------------------- settings */

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function renderSettings() {
  for (const btn of $$('#themeGroup button')) {
    btn.classList.toggle('is-active', btn.dataset.theme === state.getSetting('theme'));
  }
  for (const btn of $$('#langGroup button')) {
    btn.classList.toggle('is-active', btn.dataset.lang === getLang());
  }
  syncSizeControls();
  const measure = $('#measureSwitch');
  measure.setAttribute('aria-checked', String(state.getSetting('measure')));
  measure.classList.toggle('is-on', state.getSetting('measure'));

  const s = state.stats();
  $('#setStats').textContent = t('settings.stats', {
    essays: s.essays,
    essayWords: s.essayWords,
    words: s.lookedUp,
    clicks: s.totalClicks,
  });
}

$('#themeGroup').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-theme]');
  if (!btn) return;
  state.setSetting('theme', btn.dataset.theme);
  document.documentElement.dataset.theme = btn.dataset.theme;
  renderSettings();
});

$('#sizeRange').addEventListener('input', (ev) => {
  state.setSetting('fontSize', Number(ev.target.value));
  document.documentElement.style.setProperty('--para-size', `${ev.target.value}px`);
  $('#sizeValue').textContent = `${ev.target.value} px`;
  if (activeEssayId) rebind(ui.essayBody);
});

$('#measureSwitch').addEventListener('click', () => {
  state.setSetting('measure', !state.getSetting('measure'));
  applyMeasure();
  renderSettings();
});

$('#btnExport').addEventListener('click', () => {
  download(`essay-reader-backup-${new Date().toISOString().slice(0, 10)}.json`, state.exportJson(), 'application/json');
});

$('#importFile').addEventListener('change', (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  // NOTE: the callback parameter must not be called `t`, or it shadows the
  // translation function imported from i18n.js.
  file.text().then((content) => {
    const err = state.importJson(content);
    toast(err || t('settings.backupRestored'));
    if (!err) {
      renderShelf();
      renderWords();
      renderSettings();
    }
  });
});

$('#btnWipe').addEventListener('click', () => {
  if (!window.confirm(t('settings.confirmWipe'))) return;
  localStorage.removeItem('essay-reader:v2');
  state.loadState();
  closeAll();
  activeEssayId = null;
  renderShelf();
  renderWords();
  renderSettings();
  location.hash = '#/';
  toast(t('settings.wiped'));
});

async function checkService() {
  const el = $('#netStatus');
  try {
    await warmUp();
    const s = dictionaryStatus();
    el.textContent = t('settings.dictReady', {
      n: s.entries.toLocaleString(getLang() === 'en' ? 'en-GB' : 'zh-CN'),
      extra: s.server === 'available' ? t('settings.dictServerExtra') : '',
    });
    el.classList.remove('net--bad');
  } catch (err) {
    el.textContent = t('settings.dictFailed', { msg: err.message });
    el.classList.add('net--bad');
  }
}

/** Report install/offline capability in the interface language. */
function renderInstallState() {
  const el = $('#installState');
  if (!el) return;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const controlled = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

  if (standalone) {
    el.textContent = controlled ? t('settings.installed') : t('settings.installedBare');
  } else if (controlled) {
    el.textContent = t('settings.offlineReady');
  } else {
    el.textContent = t('settings.offlineNotReady');
  }
}

/* ------------------------------------------------------------- deployment */

/** Register the service worker so the app keeps working with no network. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // file:// cannot host a worker
  navigator.serviceWorker
    .register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      renderInstallState();
    })
    .catch((err) => console.warn('service worker unavailable:', err.message));
}

/** Warm the dictionary so the first click is instant. */
function warmDictionary() {
  warmUp()
    .then(() => {
      const el = $('#netStatus');
      if (el && document.body.dataset.view === 'settings') checkService();
    })
    .catch((err) => console.warn('dictionary warm-up failed:', err.message));
}

/* ------------------------------------------------------------------- setup */

function route() {
  const name = currentRoute();
  if (name === 'reader') {
    openEssay(decodeURIComponent(location.hash.replace('#/read/', '')));
    return;
  }
  // Leaving the essay: hide the cards (they stay pinned) and reset the badge.
  setLayerVisible(false);
  showView(name);
  if (name === 'home') renderShelf();
  if (name === 'words') renderWords();
  if (name === 'settings') {
    renderSettings();
    renderInstallState();
    checkService();
  }
}

async function boot() {
  // Language first: every other renderer reads strings through t().
  setLang(initLang());
  applyStaticTranslations();

  // A password-reset link arrives as `#access_token=…&type=recovery`. The router
  // reads location.hash as well, so claim the session before routing and then
  // send the reader to the panel that asks for a new password.
  let recovering = false;
  try {
    recovering = await adoptRecoverySession();
  } catch {
    recovering = false;
  }
  if (recovering && !location.hash) location.hash = '#/settings';

  initPinLayer(document.body, () => {
    updateOpenBadge();
  });
  document.documentElement.dataset.theme = state.getSetting('theme');
  document.documentElement.style.setProperty('--para-size', `${state.getSetting('fontSize')}px`);
  applyMeasure();

  // Offline capability: the service worker caches the app, the dictionary warm-up
  // loads the word list so the first tap answers instantly.
  registerServiceWorker();
  warmDictionary();

  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && currentRoute() === 'reader') {
      closeAll();
      updateOpenBadge();
    }
  });

  route();
  if (!location.hash) renderShelf();

  // Account wiring last: it may immediately pull a cloud copy, which repaints
  // the views this function has just created.
  initAccount({
    onDataChanged: () => {
      renderShelf();
      renderSettings();
      const name = currentRoute();
      if (name === 'words') renderWords($('#wordSearch').value);
      if (name === 'reader') route();
    },
    recovering,
  });
}

/**
 * Switch the whole interface language without reloading: re-apply the static
 * markup, then re-render whichever view is on screen.
 */
function changeLanguage(lang) {
  if (lang === getLang()) return;
  setLang(lang);
  applyStaticTranslations();
  renderSettings();
  renderShelf();
  refreshAccountPanel();

  const name = currentRoute();
  if (name === 'reader') {
    // Re-render the header and labels, keeping pinned cards alive.
    const essay = state.getEssay(activeEssayId);
    if (essay) {
      const { heading, paragraphs } = splitParas(essay.text);
      ui.essayTitle.textContent = heading && heading.length <= 70 ? heading : essay.title;
      ui.essayMeta.textContent = t('reader.meta', {
        words: essay.words,
        paras: paragraphs.length,
        date: fmtDate(essay.addedAt || Date.now()),
      });
      const seen = state.seenKeysFor(activeEssayId).size;
      ui.seenLabel.textContent = t('reader.seen', { n: seen });
    }
    updateOpenBadge();
  } else if (name === 'words') {
    renderWords($('#wordSearch').value);
  } else if (name === 'settings') {
    checkService();
    renderInstallState();
  }
}

$('#langGroup').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-lang]');
  if (btn) changeLanguage(btn.dataset.lang);
});

boot().catch((err) => {
  // A failed boot must still leave a readable page rather than a blank one.
  console.error('boot failed:', err);
});
