# Notices

This package is a DeepSeek Harness port of **Delta for Claude Code**
(https://github.com/zed-industries/delta-claude), Copyright (C) 2026 Zed
Industries, licensed AGPL-3.0-only. `LICENSE` is that project's license,
unchanged.

## Vendored code

`vendor/delta/` is a copy of the source repository's `hooks/` directory, made by
`scripts/sync-delta.mjs` (tests, fixtures and generated type declarations are
excluded). It is byte-identical to the upstream files except for the
replacements recorded in `scripts/patches.mjs`, which the sync re-applies:

- `sharing/join.ts` — the Claude Code `/clear` + `/cd` fresh-Session join
  sequence becomes an in-place transition of the current Harness Session,
  because the Harness keeps one Session per conversation and has no
  plugin-callable `/clear`. Mounting, verification, activation and failure
  handling remain upstream code.

The vendored sources still import their engine API as types only
(`import type … from 'claude-code'`); the bundles erase those imports and run
against the engine shim in `src/engine.js` and the Host adapter in
`src/bridge.js`.

## Original work in this package

- `src/engine.js` — the mod-API shim: hook registry, matcher, chain, budgets,
  failure rules and the `$` factory.
- `src/bridge.js` — the Harness implementation of every `$` call.
- `src/rows.js` — the Session-event projection into Claude Code row events.
- `src/surfaces.js`, `src/http.js`, `src/client.js` — the band's element
  serialization, same-origin API and browser renderer.
- `src/store.js`, `src/process.js`, `src/paths.js` — plugin store, subprocess
  adapters and data locations.
- `scripts/`, `test/`, `docs/` — build, tests and the parity matrix.

The band's browser renderer follows the registration shape and CSS conventions
of the shipped `@deepseek-ai/dsh-experimental-client-ui-claude-code-mods`
package (MIT), with its Remote data source replaced by this package's own
same-origin API.

## Trademarks and artwork

The plugin icon (`icon.svg`) is an original drawing for this port. It is not the
Delta logo and carries no trademark license. The names "Delta" and
"DeepSeek Harness" belong to their respective owners.
