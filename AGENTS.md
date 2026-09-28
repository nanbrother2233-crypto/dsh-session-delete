# Working in this repository

Notes for anyone — human or agent — running commands here. Read this before your
first recursive scan.

## The tree is cyclic. Do not walk it.

```
.devhome/profiles/web/node_modules/dsh-session-delete  ->  .        (junction)
```

`.devhome` is the scratch DSH home used to load this plugin without publishing
it, and it lives *inside* the repository it links back to. A recursive walk of
the repository root therefore descends into the repository root, forever.

This is not a slow walk. It exhausts path length and memory. A walk performed
inside the DSH host process — a file watcher, a workspace scan, an agent's glob
or grep — takes that process, and the session running in it, down with it. This
has happened once already in this repository.

Rules:

- **Never** run a recursive scan from the repository root: no `**/*` glob, no
  `grep -r .`, no `Get-ChildItem -Recurse`, no `find .`.
- Scope every scan to a named subdirectory: `src/`, `test/`, `scripts/`.
- When you must look at the whole tree, exclude `.devhome`, `.git`,
  `node_modules` and `.scratch` — or use `scripts/check-tree.mjs`, which
  `lstat`s each child and never enters a link.
- Do not "fix" this by deleting the junction: the scratch profile needs it, and
  `npm run check:tree` reports its absence as a problem.

`npm run check:tree` walks the tree safely, classifies every link, and fails on
a loop that is not the sanctioned dev one. Run it after touching `.devhome`.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Host half (`index`, `routes`, `service`, `store`, `encode`), the browser half under `src/client/`, and `nest` — the list-nesting walk both halves share. |
| `test/` | `node:test` suites. Run with `npm test` — the runner imports the files in-process, because `node --test` spawns a child per file and that spawn fails under a confined Windows sandbox. |
| `scripts/` | `clean`, `test` runner, and `check-tree`. |
| `research/` | Reconnaissance notes behind the implementation. Not shipped, not a build input; they record machine-local paths and are kept for provenance. |
| `lib/` | Build output. Generated — never edit, never commit (gitignored). |
| `.devhome/`, `.scratch/` | Local dev harness and scratch data. Gitignored. |

## The plugin's own contract

`lib/client.js` is a *built* artifact with a hand-rolled wrapper, produced by
`tsdown` (`tsdown.config.ts`). The host serves it verbatim and the shell
materializes it through `window.__ModuleLoader__.load`. Consequences:

- The client half is never consumed from source; a missing or stale `lib/client.js`
  fails loudly at boot. Build before running.
- Every `require()` in that bundle must resolve through the browser's frozen
  platform module table or through `dsh.client.inject`. Adding an import that is
  not in the tsdown `deps.neverBundle` list inlines the dependency instead — and
  inlining React, in particular, breaks the shell.

## Before publishing

```powershell
npm run check        # tree guard, build, typecheck, tests
npm pack --dry-run   # confirm the tarball holds lib/**, cordis.patch.yml and the docs
```

`prepack` runs `check`, so `npm pack` and `npm publish` cannot ship an unbuilt or
failing tree. The tarball is bounded by `files` in `package.json`, which is why
`.devhome/`, `.scratch/` and `research/` never appear in it. Expect 22 files and
roughly 51 kB.

Two emitted files are deliberately excluded there. `src/nest.ts` is the session
list's nesting walk: the browser half *inlines* it, and the host half never
imports it, so `lib/nest.js` and `lib/types/nest.d.ts` exist only for the tests
and for the typecheck. `"lib/**"` picks them up, and the two `!` entries in
`files` drop them again — nothing that ships references either.

If npm's cache directory is not writable — a confined sandbox, for instance — the
pack step fails with `EPERM` on `…\npm-cache\_cacache\tmp\…` *after* `prepack`
has already passed. Point the cache at the workspace instead:

```powershell
npm pack --dry-run --cache .\.scratch\npm-cache
```

`tsdown.config.ts` keeps the browser bundle's externals under `deps.neverBundle`.
That list and `dsh.client.inject` in `package.json` are two spellings of one
decision and have to agree: an import missing from both is inlined into the
bundle, and an inlined React breaks the shell. After changing either, rebuild and
check what the bundle actually asks for:

```powershell
Select-String -Path .\lib\client.js -Pattern 'require\("([^"]+)"\)' -AllMatches
# expect exactly: react, react/jsx-runtime, @deepseek-ai/dsh-client-ui-primitives
```
