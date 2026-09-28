# dsh-session-delete

List every session DSH knows about — across all workspaces — and delete them for
good.

DSH ships **Archive session**, which hides a session and keeps its data. This
plugin is the destructive counterpart: it removes a session's log, its
projection-cache checkpoint and the indexes that mention it, and it refuses to
touch anything that is still running or that it cannot resolve unambiguously.

## What it adds

A **Sessions** tab in the right side pane, offered in the pane's add-tab menu
alongside the shipped Files tab. It shows:

- every session across every workspace, newest first, grouped by working
  directory, under the same name the built-in session list shows it by (the
  log's title, else the workspace folder, else the id) — with one exception: a
  delegated child leads with the task it was spawned for (its
  `subagent/descriptor` label, e.g. `Research DSH session storage`) instead of
  the first-prompt title its log folds to, so siblings spawned for different
  jobs do not all read alike;
- a search over title, parent session, workspace path and id;
- delegated child sessions **nested under the parent they belong to**, so the
  subtree a selection covers is visible at a glance; every child row also carries
  the mark and the name of the parent it belongs to — `↳ name` — because
  indentation says where a child sits, not whose it is once its parent has
  scrolled out of view or been filtered away by the search box (the built-in
  sidebar hides child sessions entirely, so this tab is the only place they are
  listed);
- a running dot for live sessions, and `+n` — explained in its tooltip — for the
  transitive children a delete would take with it;
- multi-select, then one confirmation dialog stating how many sessions — and how
  many child sessions — are about to go.

The dialog points at the built-in **Archive session** as the non-destructive
alternative, because "delete" here means exactly that.

## What a delete removes

| Target | Detail |
| --- | --- |
| Session log directory | The whole directory under `<data-dir>/sessions/<project>/<id>/`: the current generation and every older one (`session.jsonl.zstd`, `session.vN.jsonl.zstd`, any lock sidecar). |
| Projection cache | The `session_projcache` record — removed through the live storage-domain table when the host offers it, so the in-memory table stays coherent, and from disk otherwise. |
| History cache | The session's entry in `dsh-session-plugin-history-cache.json`, when a third-party session plugin wrote one. |
| Workspace membership | Detached from any workspace listing the session, when the registry exposes a detach. |

The data directory in use is printed in the dialog footer, so you can always see
which `$DSH_HOME` you are operating on.

## What it refuses

A blocked row blocks the **whole** plan. Nothing is deleted — not even the rows
that were not blocked.

| Refusal | Why |
| --- | --- |
| **Running** | No plugin can close a live session: the detach disposer belongs to the fiber that created it, and a live writer simply re-creates a removed log. Refusing is the only honest answer. End the session first. |
| **Currently open** | The session whose right pane holds this tab is sent with every request and refused — including when it appears only as a *descendant* of a selection. |
| **Duplicate id on disk** | Two project directories claim the same id. The backend itself refuses to resolve that in `findLog`, so guessing here could delete the wrong session. |
| **Never materialised** | A session created but never written has no files to remove, and removing files cannot make it disappear. |

## Safety model

The harness webserver applies no authentication and no origin check before it
dispatches: an *exact* route is matched and invoked directly, ahead of the
Connection fence that guards DSH's own RPC channel and the SPA fallback. These
routes are exact routes, and one of them destroys user data. So:

- every mutating route requires `content-type: application/json` **and** an
  `x-dsh-session-delete: 1` header. Both are non-simple requests, so a browser
  must preflight them: a cross-site form post or a `no-cors` fetch cannot reach
  the handler at all;
- a delete additionally requires `confirm: true` in the body, so a truncated or
  replayed request cannot delete anything by itself;
- the plan is rebuilt at execution time, because the preview and the confirm are
  separate round trips and a session can go live in between; and
- the session log is found by scanning for a directory named exactly the
  *injective* encoding of the session id. The id is never used to build a path
  directly, and the encoding cannot emit a separator, so a hostile id cannot
  escape its project directory.

This raises the bar; it is not a sandbox. Anything that can reach the local port
and set its own headers can reach these routes. A bare request to that port may
still answer `401 unauthorized` — that is DSH's fence on its *own* routes, and it
does not sit in front of these.

## Install

```
dsh plugin add --save-exact dsh-session-delete@0.1.0
```

Then restart DSH Desktop — desktop activates a new bundle at boot.

The published tarball *is* the plugin: 22 files, ~51 kB compressed. There is no
build step at install time and no bundled dependency tree — the host half ships
compiled and imports only Node builtins plus `@deepseek-ai/dsh-home-paths`, and
the browser half is a prebuilt bundle that requires nothing beyond the three
platform modules the shell injects. So the same package installs anywhere DSH
Desktop runs, and nothing from the plugin's development checkout is needed:

```
npm pack                                        # dsh-session-delete-0.1.0.tgz, ~51 kB
dsh plugin add --save-exact .\dsh-session-delete-0.1.0.tgz   # or any copy of that file
```

Installing from a checkout instead (`dsh plugin add --save-exact link:D:\path\to\checkout`)
links the whole working tree into the profile, development directories included;
that is a convenience for editing the plugin, not a requirement for using it.

The exact stable version is not a suggestion: the market's install path resolves
`dsh-session-delete@latest` from npm and requires an exact stable `version` and a
valid `dsh.bundle.patch`, both of which this package declares. Publishing to npm
does not by itself put the plugin in the built-in Community Market — a catalog
provider has to list it — but the command above always works.

## Requirements

- DSH Desktop 2.0.13 / `@deepseek-ai/dsh` 0.1.5-rc.2 — the API surface this
  plugin was built and verified against.
- Node `^22.19.0 || >=24.0.0`.

## Limits

- **No per-row delete in the built-in session list.** That row menu is hardcoded
  in `dsh-client-ui-workspace` and exposes no third-party action slot, so no
  plugin can add an item to it. The manager is a right-pane tab instead.
- **A live session cannot be force-stopped.** See the refusal table above.
- **Children go with their parent.** A selected session takes its child sessions
  with it, children first, so a partially failed run never leaves an orphan whose
  parent is already gone.
- **Not a secure erase.** The files are unlinked; a filesystem recovery tool may
  still find the bytes. Use full-disk encryption if that matters to you.

## Development

See [AGENTS.md](AGENTS.md) — including the one rule this repository cannot
break: the working tree is cyclic, so never walk it recursively.

```
npm run check        # tree guard, build, typecheck, tests
npm pack --dry-run   # what would actually be published
```

## License

MIT
