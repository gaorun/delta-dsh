# Delta for DeepSeek Harness

[Delta](https://delta.dev) gives every agent thread a URL. This plugin records a
DeepSeek Harness Session and its checkout to Delta, so teammates can open the
thread, join it, and follow the work — from their own Harness Session, from
[delta.dev](https://delta.dev), or from the Delta app.

It is a feature port of [Delta for Claude Code](../README.md): the same Delta
hooks module drives it through a small engine shim that implements the parts of
Claude Code's mod API those hooks use. `docs/parity.md` lists every feature and
where the port behaves the same, differently, or not yet.

## Install

In the Harness **Settings → Plugins**, install a bundle from a local folder and
choose this `delta-dsh/` directory (or install it through the plugin manager's
`install_bundle` with the same absolute path).

Installing links the checkout, so the plugin runs without a build step: `lib/`
holds the built halves. After installing, open the Plugin Manager's plugin list
and check that **Delta** is enabled. The `/delta` commands appear in the
composer menu of a Session. The band is served by the Host half immediately,
but its browser half loads when the Harness Host starts, so **restart the
Harness app once after installing** for the band to appear above the composer.

The plugin uses the `delta` CLI. If it is not installed, the first share, join or
setup offers to install it, as the Claude Code plugin does.

## Commands

| Command | Description |
| --- | --- |
| `/delta` | Menu of the actions below |
| `/delta-share [<email>…]` | Sync this Session and its checkout, and choose who sees it |
| `/delta-join <link>` | Join a shared thread in this Session, in the thread's checkout |
| `/delta-setup` | Choose this repository's team and which sessions sync |
| `/delta-update` | Update the installed Delta app and CLI |
| `/delta-plugin-update [check \| notifications on\|off]` | Report this plugin's installation and how the Harness updates it |
| `/delta-org list\|current\|switch <ID>\|invite <email>…\|manage` | Manage your Delta team |

Each command also works as `/delta <command>`, such as `/delta share`. Setup
writes `.delta/settings.json` and keeps that file out of Git.

## Which Sessions are Delta Sessions

The Claude Code plugin runs one process per Session, so every Session it sees
gets a Delta status bar. A Harness Host runs every root Session in one process,
so the port discriminates on three levels:

1. **Which Sessions Delta follows.** Delta's hooks keep one active Session per
   process, so the port follows the Session you are viewing: opening a
   conversation moves Delta's activation, recording and thread watch to it, and
   leaves the previously viewed Session without a band. Every user-facing
   Session still gets the `/delta` command menu, so `/delta-share` works from
   any conversation. Agent-internal Sessions are never served: Team teammates
   and subagent children get no Delta start, no questions, and no status bar.
2. **When the band shows at all.** Only when Delta has something to say about
   the viewed Session: it has a thread (shared, synced, or joined), a join or
   upload in flight, a running Delta operation or watch failure, or its checkout
   has a deliberate `.delta/settings.json` policy (the "manual" reminder). A
   checkout Delta was never set up in stays quiet; `/delta-setup` and
   `/delta-share` remain one command away.
3. **When it shows a reminder.** A Session in a configured checkout with no
   thread shows Delta's own nudge toward `/delta-share` in manual mode.

## The band

Band copy follows the Harness language. With a Chinese UI the hint text is
translated — status labels, buttons, progress steps, audience, update rows — while
proper nouns stay as written: Delta, DeltaDB, team names, people's names, links,
and `/delta` commands. Every other locale shows Delta's original English. The
translation lives in `src/band-i18n.js` and is inlined into the browser bundle by
the build.


Delta draws a status band above the composer: the thread link and audience,
sync progress and failures, plugin-release notices, and its buttons. The Host
half draws the band with Delta's own hooks; the browser half renders the
resulting element tree and sends button presses back over a same-origin,
loopback-only API. A press names the drawing generation it saw, so a stale
button is refused instead of acting on the wrong state.

## Privacy

Delta stores what a recorded Session contains: your conversation, tool inputs
and outputs, model reasoning, and the files in your checkout (staged, unstaged,
and untracked files that aren't ignored). Nothing is uploaded until you share or
join a Session, or the repository's setting syncs it automatically.

The plugin runs the Delta CLI with the `claude_code` integration identifier so
Delta's producer protocol and telemetry keep accepting its records; the
transcript attributes them to **DeepSeek Harness** through the CLI's producer
name.

## Development

The Host half is a plain-JavaScript bundle with no runtime dependency on
`@deepseek-ai/*` packages: everything it uses arrives through the plugin
context. The browser half is loaded by the Harness Client module system.

```sh
cd delta-dsh
npm install            # esbuild, for the build only
node scripts/sync-delta.mjs   # copy ../hooks -> vendor/delta and re-apply the documented patches
node scripts/build.mjs        # src/ + vendor/ -> lib/index.js, src/client.js -> lib/client.js
node --test test/*.test.mjs   # engine, rows, surfaces, process and a fake-context smoke test
```

`vendor/delta/` is a copy of this repository's `hooks/`; `scripts/patches.mjs`
records and applies the only two edits (the in-place join transition). Never edit
`vendor/delta/` by hand: the sync overwrites it.

The Host tests fake the Harness context, so they never install, spawn, or touch
the network. The smoke test loads `lib/index.js`, so run `build` first.

## Troubleshooting

- **The band is missing after the Harness app restarts.** Delta follows the
  Session the page shows, and the page can mount before that Session's agent is
  registered. The browser re-asks every few seconds while the band is empty, and
  the Host retries a start Delta did not take, so it recovers on its own; if the
  page was served before this plugin was updated, refresh it once to load the
  current browser half.
- **Diagnose an empty band.** Ask the Host for the drawn state of one Session:
  `GET /delta-dsh-api/status?session=<id>`. A `tree` is what the band draws; a
  `null` tree with a `debug` object names the reason (`unfocused`, `hidden`,
  `no-session`) and Delta's activation facts.

## Known limits (v1)

- The browser half is registered from the installed package, so a Harness Host
  that was already running when the plugin was installed must be restarted
  before the band's UI appears. The Host half (commands, recording, API) activates
  immediately.
- The Harness Session log is post-commit and cannot be rewritten, so rows are
  projected from durable events rather than intercepted. Remote watch rows are
  not injected into the conversation yet, and a Delta thread reply cannot be
  answered from inside this Session's log.
- Only the main conversation is recorded; subagent Sessions, the Claude Code
  Desktop hand-off flow, and Delta's `/delta show` echo rows are not ported yet.
- Joining a thread in place converts this Session's binding to the joined
  thread (Claude Code started a fresh Session there instead). Records already
  staged for a thread this Session owned locally are left behind, not carried
  into the joined thread.
- Delta's hooks were written for one Session per process. The Harness keeps
  every open Session in one Host process, so the port follows the Session you
  view: switching conversations moves Delta's activation and thread watch, and
  a Session that is not on screen is not recorded (its staged records stay
  local). Share/join operations run in the Session that started them.
- Delta's plugin self-update path is adapted to the Harness Plugin Manager.
  `/delta-update` still updates the Delta app and CLI through Delta's own code.
- Windows-specific install and update orchestration keeps Delta's code but is
  untested here.

## License

Copyright (C) 2026 Zed Industries.

Licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
