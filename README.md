# 【插件】自动标注LetMe — dsh-plugin-letme-annotator

A DSH Desktop / DeepSeek Harness **client plugin** that watches the assistant's
thinking blocks and, whenever the reasoning text contains **let me**
(case-insensitive), places a red badge **“出现了 let me”** right after the
**Think** label and highlights every actual occurrence of the phrase in red at
its exact position inside the reasoning text.

<img width="614" height="202" alt="屏幕截图 2026-08-20 174445" src="https://github.com/user-attachments/assets/f8d7c3df-8c5e-4fed-bb0b-1a0f9fb618fa" />

- Works while reasoning is streaming; the badge appears the moment `let me`
  shows up and disappears again if the text is rewritten without it.
- Counts occurrences precisely: `出现了 let me ×2` for repeated matches. The
  count equals the number of matches in the full reasoning text of that step
  (one badge per Think row).
- **Position marking**: in the collapsed row the matching words in the visible
  summary line are highlighted; once expanded, every match in the full
  reasoning body is highlighted (CSS Custom Highlight API). The old
  whole-row left accent bar is used only as a fallback when that API is
  unavailable.
- Detects matches beyond the first line even while the Think row is collapsed
  (it reads the session snapshot, with a DOM-text fallback).

## Install

On this machine the plugin is already installed into the desktop profile
(`~/.dsh/profiles/desktop`): a junction at
`~/.dsh/profiles/node_modules/dsh-plugin-letme-annotator` (target:
`autoHighlight_LetMe` in this folder) plus an entry in the profile manifest's
`dsh.profile.bundles`. **Restart DSH Desktop** to activate.

Manual install elsewhere: junction the `autoHighlight_LetMe` package folder
into `~/.dsh/profiles/node_modules/` and add `dsh-plugin-letme-annotator` to
`dsh.profile.bundles` in `~/.dsh/profiles/desktop/package.json`, then restart.

## Layout

- `lib/client.js` — browser half (`dsh.client` bundle, lazy-CJS factory format)
- `lib/index.js` — host loader entry (no-op)
- `cordis.patch.yml` — loader patch composing this package into the profile
- `package.json` — `dsh.client` + `dsh.bundle.patch` declarations
- `test/smoke.mjs` — browser-logic smoke tests (stubbed DOM + session; the
  fake DOM notifies the MutationObserver like a real browser, so the runaway
  reconcile-loop freeze regression is covered)
- `test/compose-check.mjs` — loader-patch composition check via dsh-app-boot
- `test/repro-loop.mjs` — standalone freeze reproduction / settle check

## Customize

Edit the constants at the top of `lib/client.js`:

```js
const PATTERNS = [/\blet me\b/giu];   // match patterns
const BADGE_LABEL = "出现了 let me";  // badge text
```

Then restart DSH Desktop.


