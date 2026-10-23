# Vendored terminal text utilities

PSM's CLI and pi extension share these local utilities through `src/textwidth.ts`.
There is no runtime import of pi, pi-tui, or an external width package.

## Sources and licenses

- `utils.js`: selected functions from `@earendil-works/pi-tui` **1.4.0**,
  published `dist/utils.js`, originating in
  <https://github.com/earendil-works/pi/blob/main/packages/tui/src/utils.ts>.
  Copyright (c) 2025 Mario Zechner; MIT license in `LICENSE`.
  Published source SHA-256:
  `275c8400c37c09a7cc106445e27f676aa320c6a024dc89b540b97e1357e90e55`.
  The license was retrieved from upstream commit
  `ed76cca69b136931fd93198b4d44f5c3b59e684c` (the code is from the published 1.4.0 package).
- `get-east-asian-width/`: JavaScript files from **1.6.0**,
  <https://github.com/sindresorhus/get-east-asian-width>.
  Its Unicode lookup data and helpers are included unchanged; MIT license and
  copyright notice are preserved in `get-east-asian-width/license`.

## Extraction and local adaptations

Only width measurement, grapheme segmentation, terminal-sequence stripping,
truncation and their ANSI/OSC hyperlink helpers were retained from pi-tui.
No rendering framework, native module, wrapping engine or editor was copied.
The published JS is kept as JS to minimize transcription changes.
The sole upstream import is redirected to the local East Asian width directory.

For reproducibility, the retained inclusive line ranges of the published
`dist/utils.js` are: 3–3, 8–10, 23–44, 50–284, 370–450, 454–477,
1018–1141. A provenance comment and the local import precede these excerpts.
Function bodies are unchanged. `src/textwidth.ts` preserves PSM's `…` default
and exposes `stripTerminalSequences` under its existing `stripAnsi` name.
The adapter strips upstream-added SGR resets when both input and ellipsis are
plain text, so CLI Markdown and clipboard labels remain free of ANSI escapes.

Unicode segmentation and Unicode property regexes use Node's built-in ICU/V8;
use the project's supported Node 22 runtime. Output can therefore also depend
on the Node Unicode version.

## Updating

1. Record the new published pi-tui version and source hash; review its helper
   and package dependencies before replacing the excerpts.
2. Update the vendored East Asian width implementation/data if required,
   preserving licenses. Keep imports entirely local.
3. Run `npm test`, including explicit Unicode widths, zero budgets, ANSI/OSC,
   CLI labels, cursor visibility and selector narrow-width regressions.
4. Compare representative selector output and the crash fixture with the
   target host pi-tui's actual `visibleWidth` and `truncateToWidth` functions.
   This is an optional host compatibility check, not a production dependency.

This snapshot does not automatically follow host pi upgrades. If host width
rules change, review and refresh this copy; do not add ad-hoc codepoint patches.
