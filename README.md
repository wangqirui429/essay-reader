# Essay Reader · 英语作文阅读器

Read English essays and articles. Click any word you do not know and a card
with that word's Chinese meaning is pinned beside it. The card stays on screen
until **you** close it — it never disappears by itself.

The interface is Chinese by default and can be switched to English in Settings.
Word meanings are always Chinese, which is the point of the app.

It runs **entirely in the browser**, with the whole English–Chinese dictionary
built in. There is no server logic, no account, no network required after the
first load — so it also works as an app on your phone with your computer off.

**Live:** <https://wangqirui429.github.io/essay-reader/>

---

## Use it on your phone (no computer needed afterwards)

1. Make sure the phone and the computer are on the **same Wi-Fi**.
2. Double-click **`Start-For-Phone.bat`**.
3. It prints an address such as `http://10.16.115.93:8080`. Open it on the phone.
4. In the phone browser menu choose **Add to Home Screen**.

From then on the app is stored on the phone and opens full screen from the home
screen icon — **with the computer switched off and even in airplane mode**.
The computer is only needed for that first installation.

> The first load pulls about 7 MB (mostly the dictionary). After that the
> service worker serves everything from the device.

### Other ways to get it on a phone

| Option | How | Keeps working offline |
| --- | --- | --- |
| Local Wi-Fi install (above) | `Start-For-Phone.bat` | Yes, after first load |
| Host it publicly (below) | Upload `dist/` to any static host | Yes — it is a plain static site |
| Copy the folder to the phone | Local files, no server | Limited: `file://` cannot register a service worker |

---

## Open it from any computer (public hosting)

**Live now:** <https://wangqirui429.github.io/essay-reader/>

Open that address on any computer or phone, on any network. The first visit
downloads about 7 MB; after that the app is stored on the device and works with
no connection at all.

### How it is published

GitHub Pages serves the `gh-pages` branch, which holds a built copy of the app:

```bash
node tools/build-deploy.mjs                                   # public/ -> dist/
node tools/publish-gh-pages.mjs wangqirui429/essay-reader     # dist/ -> gh-pages
```

`tools/publish-gh-pages.mjs` uploads through the REST API rather than `git
push`, because this machine's git transport cannot reach github.com (the
connection is reset); `gh`'s HTTPS channel works fine.

To publish somewhere else, `dist/` is a plain static folder — drag it into
Netlify, Vercel, Cloudflare Pages, or any web space.

### Why not the GitHub Actions workflow?

`.github/workflows/deploy-pages.yml` is included and will work once the token
has the `workflow` scope (`gh auth refresh -s workflow`). Without that scope the
API refuses to accept workflow files, which is why publishing currently goes
through the `gh-pages` branch instead.

### GitHub Pages source settings

Repository **Settings → Pages** is set to:
- Source: **Deploy from a branch**
- Branch: **`gh-pages`** / root

### Netlify / Vercel / Cloudflare Pages

Drag `dist/` into the dashboard, or point the host at the repository with
`node tools/build-deploy.mjs dist` as the build command and `dist` as the
publish directory.

---

## Run it on the computer

```bash
node server.mjs
```

Then open <http://127.0.0.1:5180>. Zero dependencies; Node 18+.

This version adds an optional `/api/dict` proxy: when it is running, cards also
gain common phrases and example sentences. It is an enhancement only — the
bundled dictionary already answers every word without it.

## How to use

1. **Import** — paste text on the home page, drop a `.txt` file on it, or press
   *Load a sample essay* for Orwell's *A Hanging* (1931, ~1,950 words).
2. **Click a word** — a card opens next to it with the Chinese meaning, the
   phonetic spelling and exam tags (CET4, IELTS, …). Click the same word again,
   or the card's ✕, to remove that card.
3. Cards pile up independently and survive scrolling. *Close all cards* or
   `Esc` clears them at once.
4. **Saved Words** — every clicked word is recorded automatically, searchable,
   exportable as CSV.
5. **Settings** — paper/white/dark theme, text size, line width, backup
   export/restore. Data lives in the browser's localStorage.

## The dictionary

Built from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT licence), an
open English–Chinese database covering exam syllabi and corpus frequency.

- 37,332 base words plus 28,000+ inflected forms, filtered to words a learner
  actually meets (Collins-starred, Oxford 3000, exam-tagged, or in the top
  30,000 by BNC/COCA frequency).
- Irregular verb forms (`went`, `was`, `hanged`) map to their lemma, so a click
  never comes up empty.

### Loading strategy

The first click on a cold visit is limited by how fast bytes travel, so the data
is layered:

| File | Contents | Wire size | When |
| --- | --- | --- | --- |
| `data/instant.json` | 2,000 most frequent words | ~64 KB | first, unblocks the first lookup |
| `data/core-0…5.json` | ~19k everyday words, six parallel chunks | ~550 KB | streams in behind |
| `data/shards/<a-z>.json` | uncommon words by first letter | 6–570 KB | when such a word is clicked |

Measured on the public site over a slow link, this took the first answer from
about 44 s to about 1.1 s, and the second word to about 1.4 s.

Two optimisations were tried and **rejected on evidence**; the comments in
`dict-offline.js` record why, so they are not attempted again: fetching chunk 0
before the rest (serialising loses to parallel on a latency-bound link), and
preloading every shard an essay might need (it competed with the word the reader
was waiting for and made clicks slower).

Rebuild the data after changing the filtering rules:

```bash
node tools/build-dict.mjs path/to/ecdict.csv   # 770k rows -> compact JSON
node tools/split-dict.mjs                      # core chunks + letter shards
node tools/build-instant-tier.mjs              # the small instant tier
node tools/make-icons.mjs                      # PWA icons
```

## Files

| Path | Purpose |
| --- | --- |
| `public/` | The whole app — this is the deployable artifact |
| `public/js/pin.js` | Pinned meaning cards; only a user action closes one |
| `public/js/dict-offline.js` | Bundled dictionary: core + lazy shards |
| `public/js/dict.js` | Offline-first lookups, optional server enrichment |
| `public/sw.js` | Service worker making the app offline-capable |
| `public/manifest.json` | Install-to-home-screen metadata |
| `server.mjs` | Desktop server with the optional dictionary proxy |
| `tools/serve-phone.mjs` | Static server for installing on a phone |
| `tools/build-dict.mjs` | ECDICT CSV → compact dictionary |

## Tests

```bash
node test/tokenize.test.js     # 10 unit tests for the tokenizer
node tools/check-dedupe.mjs    # 6 cases pinning the gloss de-duplication rule
node verify/e2e-i18n.mjs       # 21 checks: Chinese UI, language switch, cards
node verify/check-loads.mjs    # loads a URL and reports what actually rendered
node verify/check-bad-requests.mjs  # 8 checks: malformed requests get a 400, not a hang
node verify/check-touch.mjs    # 6 checks: real touch taps, tap-target sizes
node verify/check-toggle-timing.mjs  # 4 checks: impatient vs deliberate second tap
node verify/check-close-reliable.mjs # 8 checks: ten one-tap closes, no drift
node verify/check-close-under-bars.mjs  # 6 checks: ✕ never hidden by sticky bars
node verify/check-card-sizing.mjs  # 5 checks: card height follows its content
node verify/check-speak.mjs    # 13 checks: 🔊 speaks once and does not close
node verify/diag-close-layers.mjs  # 20-tap trace across touch/click/hit-test/app
node verify/e2e-offline.mjs    # 12 checks: works with the origin server killed
node verify/e2e-subpath.mjs    # 9 checks: served under /essay-reader/
node verify/e2e-live.mjs       # public site, real browser
node verify/e2e-live-offline.mjs  # public site with the network cut
```

An older `verify/e2e.mjs` harness was removed: it asserted the English-era
labels and its long-running awaited evaluations lost their DevTools replies on
this Edge build, hanging the run. `verify/e2e-i18n.mjs` plus
`verify/check-loads.mjs` cover the same ground with short, independent reads.

## Robustness notes

### Touch on a phone

Tapping a word on a phone used to feel unresponsive, so readers tapped again.
Two separate causes, both fixed:

- **No `touch-action` declaration.** Without `touch-action: manipulation` the
  browser waits roughly 300 ms to see whether a double-tap zoom is coming
  before it dispatches the click. The first tap feels ignored.
- **The second tap closed the card.** The interaction was a plain toggle, so
  the impatient second tap — sent *because* the first looked dead — removed the
  card that had just appeared. A card now ignores a repeat tap within
  `TOGGLE_GUARD_MS` (900 ms) of opening; a deliberate tap after reading still
  closes it, and the ✕ button is never delayed.

Word tap targets also gained vertical padding on touch devices (28 px → 42 px
tall), and words are marked `user-select: none` so a long press cannot turn into
a text selection instead of a tap.

### Closing a card on a phone

The ✕ itself was the next complaint: it took several tries. Three causes:

- **The card jumped while the entry loaded.** A card is anchored by its top
  edge, and it opened as a one-line strip that grew to a full panel once the
  dictionary entry arrived. When it then no longer fitted below the word,
  `place()` flipped it above the word, moving the ✕ out from under a finger
  already heading for it. The placement side is now decided once at open time
  against a reserved height, and never re-decided; the card also *reserves* that
  height from the first frame, so nothing else on the page shifts.
- **The ✕ sat on the trailing edge**, on the path a finger naturally takes from
  the word just tapped, where a slightly-low tap missed it. It now sits at the
  leading edge, in a stronger visual style, 46 px square, with an `:active`
  pressed state so a hit is visible even if the card closes immediately after.
- **A near-miss tap did nothing.** Taps a few pixels off the ✕ landed on the
  card chrome and were ignored. Tapping the card's chrome (everything except the
  scrolling text block and 🔊) now dismisses the card too — the card covers the
  paragraph the reader wants, so any tap on its frame is a wish to leave.

`verify/check-touch.mjs` drives real touch events via CDP,
`verify/check-toggle-timing.mjs` pins the four timing behaviours, and
`verify/check-close-reliable.mjs` closes the card ten times in a row, checks
that the button does not drift while the entry loads, that a tap on the card
chrome dismisses, that ✕ still works after scrolling, and that the card stays
on screen.

### Pronunciation (🔊)

Speech had two independent faults, both fixed:

- **The button was unreachable.** The close handlers matched the whole card
  header, and 🔊 sits inside it — so `pointerup` closed the card first and the
  speak handler never ran. Every handler now checks `.card__speak` before the
  close area.
- **Silence with no explanation.** `speak()` now picks an explicit English voice
  (Android's synthesizer is otherwise free to fall back to the system default,
  which on a Chinese phone is not English), re-resolves voices when Chromium
  fires `voiceschanged`, un-pauses a stuck synthesizer, and returns a status.
  The UI turns that status into a message — "no English voice installed" and
  "this browser cannot speak" are named instead of leaving a dead button. The
  button also shows a pressed state so the tap is acknowledged before audio.

Speech must start synchronously inside the gesture; iOS Safari and WeChat's
engine reject it otherwise. `speak()` therefore performs no awaits before
`synth.speak()`. The saved-words panel reuses the same function rather than
carrying its own copy.

`verify/check-speak.mjs` — 13/13: button size, a touch tap reaching the engine
with `text`/`lang`, the card staying open, exactly one utterance per tap (all
three handlers are debounced), mouse clicks, four repeated taps, ✕ still
working afterwards, and the no-English-voice case.

### HTTP requests

`server.mjs` treats a bad request as routine traffic, not an emergency. Each of
these used to be able to strand a connection or kill the process:

- a malformed request line or Host header, where `new URL()` throws;
- an invalid percent-escape such as `/%ZZ`, where `decodeURIComponent` throws;
- a read error mid-stream while sending a static file;
- the cache directory disappearing while the server is running;
- any handler exception at all, caught by a last-resort process handler.

All of them now produce a 4xx (or a quiet recovery) and the server keeps
serving; `verify/check-bad-requests.mjs` sends each case over a raw socket and
then confirms normal requests still work.

The offline suite serves the app from a throwaway static server, lets the
service worker cache it, **stops the server**, and then verifies that clicking
an unfamiliar word still shows its Chinese meaning. That is the claim this
deployment rests on, so it is tested literally.
