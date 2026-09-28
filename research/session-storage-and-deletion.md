# DSH session storage, enumeration and hard-delete reconnaissance

- **Target**: DSH Desktop on Windows, `dsh` **0.1.5-rc.2**
- **DSH home**: `C:\Users\nan ge\.dsh\`
- **App checkout**: `D:\Tools\DSH\DSH Desktop\resources\app\`
- **Packages**: `D:\Tools\DSH\DSH Desktop\resources\app\node_modules\@deepseek-ai\`
- **Method**: read-only inspection. Real on-disk session files were decompressed with a
  throwaway script in this workspace (`research/tools/dump-frames.cjs`, `dump-session.cjs`).
  Nothing under `.dsh` or the app checkout was modified.
- **Version of record** for every claim below is the shipped `lib/index.js` (the packages ship
  compiled JS plus `lib/types/*.js`; the `types` field points at `.d.ts` files that are **not**
  present in the installed tree — `dsh-session-persistence-jsonl/package.json:15,27` lists them
  under `files` but only `lib/index.js` and `lib/worker.cjs` exist on disk).

---

## 0. Executive summary (the five answers)

1. **Format**: one *project directory* per workspace cwd under `~/.dsh/sessions/<projectKey(cwd)>/`,
   one *session directory* per session, holding a **multi-frame Zstandard** JSONL file
   `session.v3.jsonl.zstd`. Line 1 of the decompressed stream is the header record; every later
   line is an event `{type, seq, time, data}`.
2. **Enumeration**: `ctx.sessionPersistence.list()` (JSONL backend = a `readdir` walk of
   `~/.dsh/sessions` + first-frame header decode) → merged with live in-memory sessions by
   `ctx.sessionQuery.listSessions()` → served to the browser as the `session/list` remote by
   `dsh-api-session-controller`. Workspace grouping is a *separate* index
   (`~/.dsh/storages/workspace.json`) joined client-side on session id.
3. **Deletion**: **there is no delete/purge/remove API for a stored session anywhere.** The only
   "removal" surfaces are (a) `workspaceRegistry.archiveSession(id)` (adds to a hidden-set; no
   un-archive exists), (b) `KvTableImpl.delete(key)` on a storage *domain* table (this is the one
   real, official, in-memory-consistent delete — usable for the projection cache), and (c)
   `session-query-sqlite`'s index self-reconciliation (irrelevant here: mounted `:memory:`/`openAt: never`).
4. **Workspace scoping**: the session→workspace link is `header.cwd` (absolute path in the log
   header) plus the `sessionIds` array inside `workspace.json`. Project directory names are
   **lossy and truncated** (251-char cap) so they can never be decoded back to a cwd.
5. **Risk**: `~/.dsh/storages/workspace.json` and `~/.dsh/storages/session_projcache.json` are the
   only genuinely shared/index-level files; `~/.dsh/dsh-session-plugin-history-cache.json` is
   owned by a third-party plugin that is **no longer installed**. The session log itself is not
   held open between writes (verified empirically), so file-level deletion is not the hard part —
   in-memory liveness and UI invalidation are.

---

## 1. On-disk format

### 1.1 Where the roots come from

Both durable roots are set by `!!js` expressions in the shipped bundle patch, not by user config:

| Row | Config | File:line |
|---|---|---|
| `session-persistence-jsonl` | `root: !!js dshHomePath('sessions')` | `@deepseek-ai/dsh-base/cordis.patch.yml` (`- id: session-persistence-jsonl`) |
| `storage-json` | `root: !!js dshHomePath('storages')` | `@deepseek-ai/dsh-base/cordis.patch.yml` (`- id: storage-json`) |
| `session-query-sqlite` | `path: ':memory:'`, `openAt: never` | same file, and restated in `@deepseek-ai/dsh-web-app/cordis.patch.yml` |
| `session-projection-cache` | `writeEveryEvents: 200`, `writeIntervalMs: 5000` | `@deepseek-ai/dsh-base/cordis.patch.yml` |
| `attachment-local` | *(no config)* → default root | `dsh-attachment-local/lib/index.js:986` |

`dshHomePath` = `join(resolveDshHome(), ...segments)`; `resolveDshHome` precedence is
`configured > $DSH_HOME > ~/.dsh` (`dsh-home-paths/lib/index.js:73-84`).

The active profile is `~/.dsh/profiles/desktop/`; its `package.json` loads bundles
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`, and `cordis.patch.yml` in the profile is an
empty array (`[]`), i.e. **no user overrides** — the shipped roots are exactly what is in use.

### 1.2 Inventory of `C:\Users\nan ge\.dsh\`

```
.anonymous-user-id                       (global; dsh-anonymous-user-id/lib/index.js:51)
.credentials.yaml                        (global; dsh-credentials-local/lib/index.js:58)
settings.yaml                            (global; dsh-settings-file/lib/index.js:32)
profiles/                                (profile trees + hoisted node_modules)
sessions/                                (session logs — THE session store)
storages/                                (KV domains)
dsh-session-plugin-history-cache.json     (third-party plugin state; see §6)
```

No `attachments/`, no `llm-deepseek/`, no `*.db`/`*.sqlite` files exist in this install
(verified with a recursive `Get-ChildItem -Include *.db,*.sqlite,*.sqlite3`). That is direct
evidence the sqlite query backend never materialised a file here.

### 1.3 Path encoding for the workspace (project) directory

`projectKey(cwd)` — `dsh-session-persistence-jsonl/lib/index.js:874-893`:

```js
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = ""; let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i); const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
    else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
```

Rules, and how the two observed directories are produced:

| cwd | projectKey |
|---|---|
| `D:\Tools\dsh-session-delete` | `--D-Tools-dsh-session-delete--` |
| `C:\Users\nan ge\PycharmProjects\HyperD_PM25_baseline_reproduction` | `--C-Users-nan~0020ge-PycharmProjects-HyperD_PM25_baseline_reproduction--` |

- `:`, `\`, `/` collapse into a **single** `-` (a run of separators yields one dash).
- `[A-Za-z0-9._-]` stays literal (note `_` and `.` survive — hence `HyperD_PM25_baseline_reproduction`).
- Every other UTF-16 code unit becomes `~XXXX` (uppercase hex, 4 digits): the space in `nan ge`
  → `~0020`. `~` itself is escaped (it is excluded from the literal set).
- Leading dashes are stripped, then the body is **truncated to 251 chars**, then wrapped in `--`.
- **Consequence: the mapping is lossy and not reversible.** Never try to decode a project
  directory name back to a cwd.
- `cwd === undefined` (a session with no cwd) → the literal project dir `_no-cwd`
  (`projectDir()`, `lib/index.js:901-904`).

### 1.4 Session directory and log filename

`encodeSegment(raw)` — `lib/index.js:852-864`. Injective over all JS strings:
`.` → `~002E`, `..` → `~002E~002E`; `[A-Za-z0-9._-]` literal; anything else `~XXXX`.
A UUID session id therefore passes through **unchanged** (verified on disk).

`sessionDir(root, cwd, id) = join(projectDir(root, cwd), encodeSegment(id))` (`:913-915`).

Filename families:

| function | file:line | output |
|---|---|---|
| `logSuffix(compression)` | `:746-751` | `.jsonl.zstd` (zstd) or `.jsonl` (none) |
| `generationLogFilename(version, compression)` | `:760-762` | v0 → `session.jsonl.zstd`; vN → `session.v<N>.jsonl.zstd` |
| `parseGenerationLogFilename` | `:771-775` | only canonical names identify committed generations |
| current generation | `SESSION_FORMAT_VERSION` | **3** → `session.v3.jsonl.zstd` |

Observed real tree (recursive, `-Force`, no `session.lock`, no other files):

```
~\.dsh\sessions\--D-Tools-dsh-session-delete--\6183afbc-376b-4c5f-907e-3e76e0e1cee5\session.v3.jsonl.zstd  (24461 B)
~\.dsh\sessions\--D-Tools-dsh-session-delete--\b1eaec0a-9c0b-41dc-858e-16517b37fcf9\session.v3.jsonl.zstd  (23460 B)
~\.dsh\sessions\--D-Tools-dsh-session-delete--\b644d171-87b2-448c-925b-6b5ebaf1a5ec\session.v3.jsonl.zstd  (25227 B)
~\.dsh\sessions\--D-Tools-dsh-session-delete--\session-b7fdaf6c-af8b-4543-a326-fb2565d71d62\session.v3.jsonl.zstd (107990 B)
~\.dsh\sessions\--C-Users-nan~0020ge-...--\session-3481b90f-ca6a-40cb-98d6-ce7bc4cfd0a9\session.v3.jsonl.zstd (286199 B)
```

Practical consequence for a deleter: a session directory may contain **several generations**
(e.g. a leftover `session.v2.jsonl.zstd` after a migration, or the v0 name `session.jsonl.zstd`).
`resolveGenerationInDirectory` picks the numerically highest (`:3160-3192`), and
`listSessionDirs` treats the session dir as the unit. **Remove the whole directory, not the file.**

### 1.5 The log is *multi-frame* Zstandard, not a plain `.zst` of the whole file

This is the single most important format fact. Each append writes an independent zstd frame
(`readZstdPrefix` iterates `decodedFrames`, `:2791-2857`; `appendLines` opens the file with `"a"`
and fsyncs per batch, `:3046-3073`). In one real file: **140 454 compressed bytes → 76 frames,
136 event lines**; a plain `zstdDecompressSync(file)` returns only the first frame (284 bytes:
the header line). Use a frame-scanning decoder (see `research/tools/dump-frames.cjs`) if you ever
need to parse a log yourself; better, don't — use `ctx.sessionQuery.readSession(id)`.

### 1.6 Header record (line 1, first frame)

Built by `toHeaderLine` / `fromHeaderLine` (`:807-836`); the required/optional key allowlist is
`HEADER_REQUIRED_KEYS = [type, version, id, createdAt, isSeeded, delegationDepth]` and
`HEADER_OPTIONAL_KEYS = [cwd, parentSession, origin, agentPreset]` (`:776-790`); guarded by
`isHeaderLine` (`:838-840`), which also requires `cwd` to be absolute and `origin` to be exactly
`"subagent"` when present.

Real, verbatim header lines read from disk:

```json
{"type":"session","version":3,"id":"6183afbc-376b-4c5f-907e-3e76e0e1cee5","createdAt":1790238079236,"cwd":"D:\\Tools\\dsh-session-delete","parentSession":"session-b7fdaf6c-af8b-4543-a326-fb2565d71d62","isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
```
```json
{"type":"session","version":3,"id":"session-3481b90f-ca6a-40cb-98d6-ce7bc4cfd0a9","createdAt":1790212879525,"cwd":"C:\\Users\\nan ge\\PycharmProjects\\HyperD_PM25_baseline_reproduction","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

Notes for a plugin:
- `id` — the durable session identity. Top-level/user sessions are minted as
  `session-<uuid>` (`dsh-session/lib/index.js:1377` mints `session-<n>` when no id is supplied;
  the app supplies `session-<uuid>`); **subagent sessions here are bare UUIDs**
  (`6183afbc-…`, `b1eaec0a-…`, `b644d171-…`) and carry `origin:"subagent"` +
  `parentSession` + `delegationDepth:1`.
- `cwd` — the absolute workspace path. **This is the authoritative session→workspace link.**
- `createdAt` — epoch ms; `version` — log format version (3); `isSeeded` — fork/seed lineage;
  `agentPreset` — preset id.
- There is **no `title` field in the header** — titles live in the projection cache (see §1.7)
  and are folded from `session/title` events (`dsh-session-query/lib/index.js:1098-1129`).
- `assertNoRetiredHeaderFields` (`:796-799`) refuses `sandboxMode`/`approvalPolicy`; a reader
  must tolerate only the allowlisted keys.

### 1.7 Event records (lines 2..N)

Envelope: `{"type": <string>, "seq": <int>, "time": <epoch ms>, "data": {...}}`
(`eventLine`, `:953-955`). Real sample:

```json
{"type":"tool/call","seq":14,"time":1790238080614,"data":{"turn":1,"step":1,"callId":"call_00_…","name":"pwsh","arguments":"{\"command\": … }"}}
{"type":"sandbox/mode","seq":1,"time":1790238079241,"data":{"mode":"workspace-write","source":"delegation"}}
{"type":"subagent/descriptor","seq":0,"time":1790238079241,"data":{"version":3,"mode":"continuable","provider":"spawn","label":"…","agentProvider":"deepseek-official","agentModel":"deepseek-flash","agentReasoningEffort":"high"}}
```

Event-type histogram of one complete real subagent session (136 events):

```
31 tool/call      31 tool/result    21 step/start    20 assistant/message   20 step/end
 2 agent/inbox/spliced    2 user/message    1 subagent/descriptor   1 sandbox/mode
 1 approval/policy   1 turn/start   1 system/message   1 request/header   1 request/context
 1 session/title     1 todo/write
```

The vocabulary is closed and validated fail-closed: `KNOWN_SESSION_EVENT_TYPES`
(`dsh-session/lib/types/known-event-types.js`) plus `validateStoredEvents`
(`dsh-session-persistence/lib/index.js:182-197`) — an unknown type **without** `ignorable:true`
makes the log unreadable ("upgrade the harness"). Irrelevant to deletion, relevant if you ever
hand-edit a log.

### 1.8 The storage units under `~/.dsh/storages/`

Exactly **two** storage domains exist in the whole install (grep for `defineDomain(` across
`@deepseek-ai` finds only these two):

| domain | spec | layout | files |
|---|---|---|---|
| `session_projcache` | `dsh-session-projection-cache/lib/index.js:89-101` — version **7**, `compatibleVersions [3,4,5,6]`, `invalidRecords: "backup-and-skip"`, `layout: "per-record"`, table `sessions` | per-record | `storages/session_projcache/sessions/<sessionId>.json` |
| `workspace` | `dsh-workspace/lib/index.js:248-260` — version **2**, `global` = `{initialized, workspaceIds, archivedSessionIds}`, table `workspaces` | *(default)* single | `storages/workspace.json` |

`layout` is optional and only validated to be `"single"`/`"per-record"`
(`dsh-storage-domain/lib/index.js:65-68`); the json backend picks `openPerRecordUnit` only for
`"per-record"` (`dsh-storage-json/lib/index.js:575`), so `workspace` is the whole-file
`<root>/<name>.json` unit (`:178-179`).

**Per-record projection cache document** (real file, `session-4f0eafa2-*.json`):

```json
{ "version": 7,
  "record": {
    "identity": { "createdAt": 1787037540884, "cwd": "D:\\Vasen\\auto-test" },
    "rows": {
      "sessionStats": { "ver": 1, "seq": 15380, "val": { "turns": 2, "steps": 35, "llmMs": …, "lastTurn": …, "openStep": null, "pendingCalls": {} } },
      "title": { "ver": 1, "seq": …, "val": "…" },
      "goal": { "ver": 4, "seq": …, "val": null },
      "tokenUsage": { … }, "contextPressure": { … }, "contextBreakdown": { … }
    } } }
```

Record schema: `identity` = `{formatVersion, createdAt, cwd, isSeeded, inheritedEventCount}`
(`:48-54`), `rows` = `key → {ver, seq, val}` (`:27-31`). The record is *bound to a log
lifecycle*: `identityMatches` refuses a record whose `createdAt`/`cwd`/`isSeeded`/
`inheritedEventCount` disagree with the live/stored header (`:379-389`) — so a stale cache row
for a **re-created id** is ignored automatically. Writing is whole-record replacement
(`put`, `:346-353`).

**Workspace document** (real file) — note the two session-id collections, which are different
kinds of state:

```json
{ "unit": {"name":"workspace","version":2},
  "global": { "initialized": true,
              "workspaceIds": ["40a35c84-…","48312d80-…"],
              "archivedSessionIds": ["session-f7932436-…","session-4f0eafa2-…"] },
  "tables": { "workspaces": {
      "48312d80-…": { "path": "C:\\Users\\nan ge\\PycharmProjects\\HyperD_PM25_baseline_reproduction",
                      "title": "…", "sessionIds": ["session-3481b90f-…"],
                      "createdAt": "…", "updatedAt": "…" },
      "40a35c84-…": { "path": "D:\\Tools\\dsh-session-delete", "title": "dsh-session-delete",
                      "sessionIds": ["session-b7fdaf6c-…"], "createdAt": "…", "updatedAt": "…" } } } }
```

### 1.9 Explicitly *not* present

- No `session.lock` file exists in any session directory. On Windows the write lock is a **named
  kernel semaphore** whose name is derived from the lock path — "a kernel object never touches the
  filesystem" (`dsh-session-persistence-jsonl/lib/index.js:544-552`); the lock *file* name
  `session.lock` (`LEASE_FILENAME`, `:642`) is POSIX-only (`:686-711`).
- No durable full-text index (sqlite mounted `:memory:`).
- No attachments directory (no images were ever attached in this profile).

---

## 2. Enumeration — who reads what

### 2.1 The authority: `ctx.sessionPersistence.list()`

Service name **`sessionPersistence`** (`dsh-session-persistence/lib/index.js:261-265`).
Implemented by `JsonlSessionPersistence` (`dsh-session-persistence-jsonl/lib/index.js:2259`).

Public surface:

| method | file:line | notes |
|---|---|---|
| `create(header, options)` | `:2322` | takes write ownership; lazily materialises on first append/flush |
| `open(id, access, options)` | `:2345` | `access: "read" \| "write"`; returns a `JsonlSessionHandle` |
| `stat(id, options)` | `:2421` | one-session snapshot (header + revision + sizeBytes) |
| `list(options)` | `:2454-2481` | **the enumeration call** |
| `flush()` | `:2411` | service-wide durability barrier |
| `locate(meta)` | `:2307-2312` | *the absolute artifact path for a header* — handy for a deleter, but not exported |

`list()` = `listArtifacts()` + this process's created-but-unmaterialised sessions:

```js
async listArtifacts(signal) {                       // :2858-2888
  await this.ensureRootEncoding();
  for (const project of await this.listProjectDirs(signal))        // readdir(root) → directories
    for (const dir of await this.listSessionDirs(project, signal)) // readdir(project) → directories
      { const selected = await this.resolveGenerationInDirectory(dir, signal);   // highest vN
        header = await this.readGenerationHeader(selected, …) }                  // first zstd frame only
}
```

- `listProjectDirs` — `readdir(this.root)` filtered to directories; ENOENT → `[]` (`:3256-3266`).
- `listSessionDirs` — `readdir(project)` filtered to directories; a loose `*.jsonl[.zstd]` file at
  project level throws the legacy-layout error (`:3267-3275`).
- `readGenerationHeader` reads **only the first frame** (`readFirstZstdLine`) — cheap listing
  (`:2889-2924`).
- `findLog(id)` scans **every** project directory for `encodeSegment(id)`, and throws
  `duplicate JSONL session id "…" appears in multiple project directories` if two match
  (`:3194-3207`). Lookups are therefore id-keyed and workspace-agnostic.
- Unmaterialised sessions appear via `tracker.pendingEntries()` (`:2475-2478`, tracker at `:274-437`).

### 2.2 The facade: `ctx.sessionQuery.listSessions()`

Service **`sessionQuery`** = `SessionQueryEngine` (`dsh-session-query/lib/index.js:1034-1049`),
`static inject = ["sessions"]`, optional `sessionPersistence` binding (`:77-88`).
`listSessions()` merges persisted + live with **live precedence**, newest-first, cloning headers
(`:94-115`). Other public methods: `observeSession`, `readSession`, `filterSessions`, `readTitle`,
`readTitleSnapshot(s)`, `listEvents`, `filterEvents`, `readSurface`, `traceSession`, `traceEvent`,
`readEvent` (`:1056-1232`). This is the right read dependency for "enumerate everything";
`listEvents`/`readSession` avoid re-implementing the zstd frame walk.

### 2.3 The wire: `dsh-api-session-controller`

Host: `SessionController.list()` → `await this.ctx.sessionQuery.listSessions(signal)`, then a live
summary per live session, `summarizeCold(header)` otherwise; **`if (record.header.cwd === void 0) continue;`**
— a cwd-less session is never listed (`dsh-api-session-controller/lib/index.js:1829-1859`).
Remotes declared at `:2499-2514`: `list, search, create, selectModel, modelCatalog,
openWorkspacePath, rename, fork, prompt, attachment, updateQueue, cancel, page, follow, control`.
**There is no delete/close remote.**

Client half (`dsh-api-session-controller/lib/client.js`) provides the browser-side `sessions`
service (`rootCtx.reflect.provide("sessions", this, undefined)`, `:3087`, and
`lib/types/client/sessions/service.js:146`) with:

- `refresh()` → `manager.refreshList()` → `remote.session.list({})`, single-flight
  (`:2485-2496`, `:3141-3143`) — **the way to force the sidebar to re-read the host baseline**;
- `handleSessionRemoved(sessionId)` (`:2721-2748`) — invoked from the forwarded event
  (`:3510-3511`); it drops the row, its projection store, queues and job mirror, unless the
  session is a known durable subagent, in which case it only flips `running:false`.

Host→browser event relay is a **fixed allowlist**: `dsh-api-remotes/lib/types/remote-events.js:12-32`
(and the compiled twin at `lib/index.js:17-…`), containing `api-session/added`,
`api-session/removed`, `api-session/status`, `api-session/activity`, … A plugin cannot add to it,
but a **host-side** plugin can `ctx.emit("api-session/removed", sessionId)` because the host emits
that event itself on disposal (`dsh-api-session-controller/lib/index.js:2752-2754`).

### 2.4 Grouping: `dsh-client-ui-workspace` + `ctx.workspaceRegistry`

The sidebar never reads the filesystem. `WorkspaceBrowser`/`SessionTree` consume two client stores:
`sessions.list` (the RPC baseline above) and `workspaces.list`
(`dsh-client-ui-workspace/lib/client.js:1464-1530`, `:1976-1990`). Grouping logic:

- rows come from `workspaces[].sessionIds`, filtered to ids that still exist in the session store:
  `sessionIds: workspace.sessionIds.filter((id) => list.byId[id] !== void 0)` (`:1498`);
- ids in `archivedSessionIds` are hidden (`:49-53`, `:155-156`);
- sessions accounted by no workspace become an "ungrouped" account (`:1489-1501`).

So a session id left behind in `workspace.json` is **harmless** once the session itself is no
longer in the session list, and the workspace registry filters stale membership on read:
`entity.sessionIds` = `record.sessionIds.filter(id => host.sessionPath(id) === record.path)`
(`dsh-workspace/lib/index.js:102-104`), with pruning baked into the single write path
(`mutate`, `:173-191`).

### 2.5 Which package a plugin should depend on

| Need | Use | Why |
|---|---|---|
| (a) enumerate all sessions across all workspaces | **`@deepseek-ai/dsh-session-query`** (`ctx.sessionQuery.listSessions()`), injected as `sessionQuery` | live-preferred, cross-workspace, one call, includes unmaterialised sessions; `sessionPersistence.list()` alone misses live ones and gives raw snapshots |
| read one session's events | `ctx.sessionQuery.readSession(id)` / `listEvents(id)` | hides the multi-frame zstd walk and the migration gate |
| (b) delete one | **nothing exists** — `@deepseek-ai/dsh-session-persistence-jsonl` for the *path scheme* (`locate()`/`resolveCurrentLog()` are public instance methods but the path helpers are **not exported**: the package exports only `JsonlCompressionSchema` and `default`, `:3361`) | a deleter must either depend on the backend for lookups or reimplement `encodeSegment`/`projectKey` |
| invalidate the projection cache | `@deepseek-ai/dsh-storage-domain` (service `storageDomain`) | `domain.table("sessions").delete(key)` is the only official in-memory-consistent delete (§3.3) |
| detach workspace membership | **`@deepseek-ai/dsh-workspace`** (`ctx.workspaceRegistry`, `static inject = ["storageDomain","sessionPersistence"]`, `:314-333`) | `get(workspaceId).detachSession(id)` |
| refresh the sidebar | client plugin calling `ctx.get("sessions").refresh()`, or host `ctx.emit("api-session/removed", id)` | `api-session-controller` client `:3141`, `:2721` |

Both optional services are resolved with `ctx.get(...)` and are allowed to be absent
(`sessionQuery`'s optional persistence fiber, `dsh-session-query/lib/index.js:77-88`;
`dsh-session-query` search explicitly errors when the provider is missing, `:1869-1870`).

---

## 3. Deletion surface

### 3.1 What exists (exhaustive)

| API | file:line | What it really does |
|---|---|---|
| `workspaceRegistry.archiveSession(sessionId)` | `dsh-workspace/lib/index.js:446-456` | appends the id to `global.archivedSessionIds` in `workspace.json`. Hides the row from every grouping surface. Requires the session to still be known (`sessionKnown`, `:463-468`). **It does not delete anything.** |
| `KvTableImpl.delete(key)` | `dsh-storage-domain/lib/index.js:264-277` | the only real delete: `unit.deleteRecord(table,key)` → `rm(<root>/<name>/<table>/<key>.json)`, then drops the in-memory row and emits `domain/changed {operation:"deleted"}`. Idempotent. |
| `PerRecordJsonUnit.deleteRecord` | `dsh-storage-json/lib/index.js:466-471` | `rm(join(tableDir(table), `${key}.json`), { force: true })` |
| `SessionQueryEngine` sqlite index `_deleteSession` | `dsh-session-query-sqlite/lib/index.js:760-769` | **not a public API** — internal reconciliation: rows missing from a fresh `persistence.list()` are deleted from the derived index (`:656,681,688`). Only active if the index is enabled; here it is `:memory:`/`openAt: never`. |
| `sessionPersistence.*` | `dsh-session-persistence-jsonl/lib/index.js:2322-2481` | `create/open/stat/list/flush` — **no delete.** `rm` appears in this package only for staging/temp files and encoding-mismatch cleanup (`:602, :2010, :2018, :2977, :2981, :2995`). |
| `ctx.sessionProjectionCache` | `dsh-session-projection-cache/lib/index.js:135-359` | `recordFor`, `cachedSnapshot`, `cachedPredecessorTitle`, `hydratePrepared`, `write`, `coldSnapshot` — **no invalidate/delete.** Its `dirty` map (`:144`) is per-session-object, cleared on `session/disposed` (`:313-317`). |
| `ctx.sessions` | `dsh-session/lib/index.js:1311-1626` | `create`, `prepare`, `enter` (returns the **detach disposer**), `announce`, `flush`, `get`, `list`, `fork`. **No `dispose(id)`/`delete(id)`.** Disposal is only reachable through the disposer handed to the *owner* fiber. |
| Whole-package grep | `delete|remove|dispose|purge|rm` over all `@deepseek-ai` `*.js` | no `deleteSession`/`removeSession`/`session/delete`/`purge` anywhere except the sqlite reconciliation above and `rename`/`archiveSession` RPCs. |

`archivedSessionIds` is **append-only**: grepping the whole package tree for
`unarchive|unArchive|archivedSessionIds.filter|removeArchived` returns **no matches**. Nothing
ever prunes that array.

### 3.2 (i) How a plugin can stop/close a live session

There is no public close-by-id. The lifecycle is owned by the creating fiber:

```
agentLoop.prepare(ownerCtx, id, …)            // dsh-agent-loop/lib/index.js:1625
  └─ ownerCtx.effect(function* () { … yield () => dispose(true) })   // :1681-1690
  └─ publish()  → detachSession = agent.ctx.sessions.enter(session)  // :1714
                  detachAgent   = loopCtx.agents.enter(agent, parent) // :1715
  └─ returns { agent, signal, publish, dispose }                     // :1709-1728
dispose(): abort → machine.cancel({kind:"disposed"}) → machine.whenIdle()
           → machine.scope.dispose() → handle.close() → detachAgent(); detachSession()  // :1646-1677
```

`handle.close()` is what flushes and releases the persistence write handle; `detachSession()`
removes the store entry and emits `session/disposed` (which is what makes the jsonl backend close
the writer, `dsh-session-persistence-jsonl/lib/index.js:420-426`, and what makes the UI drop the
row, `dsh-api-session-controller/lib/index.js:2752`).

Practical options for a plugin, best → worst:

1. **Design around it**: delete only *non-live* (cold) sessions, and refuse (or queue) when
   `ctx.sessions.get(id) !== undefined || ctx.agents.get(id) !== undefined`. This is the only
   safe-by-construction option.
2. **Ask the owner to dispose**: if the plugin can reach the object that received `dispose`
   (e.g. it created the session itself via `ctx.agentLoop`), call it. Nothing exposes that per id.
3. **Interrupt only** (does not close): `ctx.subagents.interrupt(targetSessionId, authority)` for
   *continuable subagent children* (`dsh-subagent/lib/index.js:1818-1827`), or
   `agent.cancel(cause)` on the live agent (`dsh-agent-loop/lib/index.js:798`) — both leave the
   session live and materialisable, so a hard delete afterwards would be re-created on the next
   append. **Do not delete a live session's files.**
4. Disposing/`ctx.effect` teardown of a *parent* scope you own — out of reach for a
   third-party plugin operating on the app's sessions.

### 3.3 (ii) How a plugin removes persisted data

The one officially supported, in-memory-coherent removal is the storage-domain table delete:

```js
// data plane, no bespoke file I/O, keeps the live domain table coherent
const domain = ctx.storageDomain.get("session_projcache");   // DomainImpl (dsh-storage-domain/lib/index.js:110-229)
await domain.table("sessions").delete(sessionId);            // :264-277 → rm …/sessions/<id>.json + emits domain/changed
```

For the session *log* there is no such API, so the plugin must do filesystem work itself. The
robust, id-only algorithm (no cwd needed, no decoding of lossy names):

```
root = <dshHome>\sessions
name = encodeSegment(sessionId)                      // reimplement from :852-864 (package does not export it)
for each projectDir in readdir(root, dirs):          // includes `_no-cwd`
    candidate = join(projectDir, name)
    if isDirectory(candidate):                        // encodeSegment is injective → exact match
        assert at least one canonical generation file parses for the configured compression
        rm -rf candidate                              // dir, NOT just the vN file
        (optionally rmdir projectDir when now empty)
```

Optional refinement: read the header (`ctx.sessionQuery.readSession(id).session.cwd`) and compute
`projectKey(cwd)` to shorten the search — but keep the scan as the fallback, because `projectKey`
collides/truncates and a header may live in a directory that does not match its current cwd.

### 3.4 (iii) Invalidating caches so the UI list actually updates

| Layer | What must happen | Evidence |
|---|---|---|
| jsonl backend `coldLogMemo` (bounded LRU of parsed logs) | **nothing.** Reads re-resolve the path via `findLog`; with the directory gone `requireStoredLog` throws `SessionPersistenceNotFoundError`, and the memo is also keyed by a stat-derived revision | `:2519-2530`, `:2691-2698`, `:2705-2716` |
| jsonl backend `tracker.pending` (created-but-unmaterialised) | a session that never materialised is listed from memory (`:2475-2478`) and has **no files**; deleting files cannot remove it — only closing the write handle does | `:274-437` |
| projection cache (durable rows + live in-memory table) | `ctx.storageDomain.get("session_projcache").table("sessions").delete(id)` — removes the doc, the in-memory row read by `recordFor`/`cachedSnapshot`, and emits `domain/changed` | `:264-277`, `:168-192` |
| `sessionProjectionCache.dirty` (write-behind timers) | cleared on `session/disposed`; for a cold session there is no entry | `:313-317` |
| `sessionQuery` corpus | **nothing** — it re-lists persistence on every call | `dsh-session-query/lib/index.js:94-115` |
| `workspaceRegistry.headers` / `sessionPaths` caches | not invalidated, but harmless: `entity.sessionIds` filters on `sessionPath(id)`, and the client additionally filters on `list.byId[id] !== void 0` | `dsh-workspace/lib/index.js:102-104`; `dsh-client-ui-workspace/lib/client.js:1498` |
| browser session list | the client store only re-pulls on connect/refresh (`handleConnected` → `refreshList`, `:2787-2793`). A host plugin should `ctx.emit("api-session/removed", id)` (forwarded per `remote-events.js:18`, handled at `:2721`); a client plugin can call `ctx.get("sessions").refresh()` | see §2.3 |
| optional durable sqlite index | if a deployment enables one, its next stable observation deletes rows for sessions missing from `persistence.list()` — self-healing, no action needed | `dsh-session-query-sqlite/lib/index.js:650-706, 760-769` |

---

## 4. Workspace scoping

- **Session → workspace**: `header.cwd` (absolute, written into the log's first line; validated
  absolute by `isHeaderLine`). The workspace registry derives `sessionPaths`/`headers` from
  `sessionPersistence.list()` + live sessions (`listStoredHeaders`, `dsh-workspace/lib/index.js:728-736`)
  and corroborates it by `realpath`-normalising the cwd (`attachSession`, `:111-129`, which throws
  if `cwd` does not resolve, is not a directory, or resolves elsewhere).
- **Workspace → sessions**: ordered `sessionIds` array in the `workspaces` table of
  `storages/workspace.json`, plus registry-global `workspaceIds` (display order) and
  `archivedSessionIds` (hidden set).
- **"List sessions of all workspaces"** needs no workspace knowledge at all: `ctx.sessionQuery
  .listSessions()` returns every persisted (any project dir) and live session across the whole
  home, each carrying `cwd`. Note the controller then drops cwd-less records
  (`dsh-api-session-controller/lib/index.js:1841`), and records that live under `_no-cwd` on disk.
  To group them, join on `cwd === workspace.path` (the client does exactly this, e.g.
  `dsh-client-ui-workspace/lib/client.js:45-53`).
- The observed mismatch — 5 session directories on disk vs 12 documents under
  `storages/session_projcache/sessions/` vs 3 ids in `workspace.json` — is consistent with manual
  deletion of session directories in the past, leaving orphan cache documents and stale ids. It
  confirms the caches are not swept.

---

## 5. Exact files to remove for a complete hard delete

Given session id `S` (and, optionally, its `cwd`):

**Required**

1. `<DSH_HOME>\sessions\<projectKey(cwd)>\<encodeSegment(S)>\` — remove the **whole directory**
   recursively. It contains the current log `session.v3.jsonl.zstd`, possibly older generations
   (`session.jsonl.zstd` for v0, `session.v1.jsonl.zstd`, `session.v2.jsonl.zstd`) and, on POSIX
   only, `session.lock`.
   *If `cwd` is unknown*: for every `<DSH_HOME>\sessions\*`, test for a child directory named
   exactly `encodeSegment(S)`; delete each match (and treat >1 match as the duplicate-id anomaly
   that `findArtifacts`/`findLog` already refuse: `:3204`, `:2878`). Never decode the project name.
2. `<DSH_HOME>\storages\session_projcache\sessions\<S>.json` — the per-record projection
   checkpoint (title, `sessionStats`, `tokenUsage`, `goal`, `contextPressure`,
   `contextBreakdown`, `sessionListMetadata`). **Prefer**
   `ctx.storageDomain.get("session_projcache").table("sessions").delete(S)` so the live in-memory
   domain table and the `domain/changed` notification stay coherent.
3. Workspace membership: `ctx.workspaceRegistry.get(workspaceId)?.detachSession(S)` — rewrites
   `storages/workspace.json` (`sessionIds`). Skippable without visual harm (the id is filtered at
   read time), but this is the tidy, API-sanctioned way; do **not** rewrite `workspace.json`
   yourself.
4. Stop the session first if it is live: abort unless `ctx.sessions.get(S) === undefined` **and**
   `ctx.agents.get(S) === undefined` **and** it is not in `sessionPersistence`'s pending set —
   otherwise the writer will re-materialise the log you just deleted.

**Recommended (UI coherence)**

5. Host: `ctx.emit("api-session/removed", S)` so browsers drop the row
   (forwarded → `handleSessionRemoved`). Client-side plugin alternative:
   `ctx.get("sessions").refresh()`.
6. `<DSH_HOME>\dsh-session-plugin-history-cache.json` — **edit, don't delete**: remove
   `sessions[S]`. This file is per-session state inside one shared document; its writer (a
   third-party plugin, `@heeweelee`-namespaced per the market log and the earlier session history)
   is **not installed** in this profile — no `history-cache` string exists anywhere in
   `resources\app\node_modules` — so the file is already orphaned. Handle it defensively
   (read-modify-write, skip if absent).

**Do not touch**

7. `<DSH_HOME>\storages\session_projcache.json` — the **legacy whole-unit file**. It is read only
   as a bootstrap seed, and only while the `sessions/` table directory holds **no** `*.json`
   document at all (`loadPerRecordState` → `some(Boolean)` → `bootstrapLegacyUnit`,
   `dsh-storage-json/lib/index.js:338-404`, contract at `:292-298`). Leave it as-is. Do **not**
   "clean" S out of it: it is shared and inert, and an edit risks corrupting a file the backend
   validates. (Edge case: if you ever delete *every* per-record document, this legacy file will
   re-seed the old ids on the next open — see §7.)
8. `<DSH_HOME>\storages\workspace.json` — shared index: workspace list, display order, archive set.
   Never remove the file or a `workspaces` record for a session delete.
9. `<DSH_HOME>\attachments\v1\**` (when present) — content-addressed image bytes, **not
   session-scoped** (`dsh-attachment-local/lib/index.js:986`, `commitPreparedImageFile`). A
   per-session delete must not remove them; there is no refcount API.
10. `<DSH_HOME>\sessions\<projectKey>\` itself — optional to prune; an empty project dir produces
    no phantom row (`resolveGenerationInDirectory` returns `undefined` for an empty dir,
    `:3161-3192`; `listArtifacts` `continue`s, `:2868-2869`).

**Optional cleanup (no reader depends on it)**

11. `global.archivedSessionIds` in `workspace.json`: S may be present. There is **no API to
    remove** an archived id (no un-archive anywhere in the tree), and nothing prunes it, so it
    stays as inert orphan state. If a future session ever reused the id it would be born hidden,
    which is the only real (minor) hazard. Correcting it would require writing the domain global
    behind the registry's back (the registry's in-memory `state` is authoritative and is re-written
    on every mutation, `dsh-workspace/lib/index.js:770-772`), so **leave it alone** unless you also
    control the registry.

---

## 6. Risk inventory

### 6.1 Shared / index-level (deleting naively loses unrelated data)

| File | Scope | Risk if deleted | Mitigation |
|---|---|---|---|
| `storages\workspace.json` | **all** workspaces, display order, archive set | total loss of workspace grouping and archive state | mutate only via `ctx.workspaceRegistry` |
| `storages\session_projcache.json` | legacy whole-unit seed for **all** sessions | triggers legacy bootstrap → old projection rows reappear if the per-record tree is empty | treat as read-only |
| `sessions\<projectKey>\` | every session of one workspace | removes sibling sessions | delete only the `<encodeSegment(id)>` child dir |
| `dsh-session-plugin-history-cache.json` | per-session map in **one** shared document | wipes third-party per-session history for *all* sessions | read-modify-write one key |
| `settings.yaml`, `.credentials.yaml`, `.anonymous-user-id` | global | user settings / credentials / telemetry identity | never touch |

Per-session (safe to remove individually): `sessions\<projectKey>\<id>\` and
`storages\session_projcache\sessions\<id>.json`. Every other durable artifact in the home is
either global (above) or per-session-inside-a-shared-file (the history cache).

### 6.2 Locking / concurrency

- **Write ownership is a kernel lock per session directory.** POSIX: non-blocking `flock` on
  `session.lock`. Windows: a **named kernel semaphore** derived from the lock path — *no lock file
  exists*, and the doc explicitly notes "readers, searches, and directory removal proceed freely
  while the lock is held" (`dsh-session-persistence-jsonl/lib/index.js:544-552`, `:611-639`).
  Contention surfaces as `SessionAlreadyOwnedError` (`dsh-session-persistence/lib/index.js:44-52`).
  Consequence for a deleter: **the lock will not stop you, and you cannot rely on it to detect a
  live writer.** Probe the in-memory registries instead (`ctx.sessions`, `ctx.agents`,
  `sessionPersistence`'s pending set).
- **The log file is not held open between writes.** `appendLines` does `open(path,"a")` …
  `handle.close()` in a `finally` for every batch (`:3046-3073`). Empirically verified: opening
  every one of the 5 logs on this machine with `ShareMode.None` **succeeded**, including the log of
  the currently-running parent session — i.e. at that instant no process held any handle. Expect
  only *transient* `EBUSY`/`EPERM` while an append is in flight → retry with backoff, and do not
  conclude "the session is live" from a sharing violation. (Attempting a write-mode open was
  denied by the DSH file sandbox with `UnauthorizedAccessException`, so sharing-mode confirmation
  could only be done read-side.)
- **Live writers re-materialise.** A live session whose write handle is still open will recreate
  the session directory on its next materialising write (and an unmaterialised session is listed
  from memory with no files at all). This is the strongest argument for refusing to delete live
  sessions.
- **`findLog` scans every project dir on every read** (`:3194-3207`) — O(projects) per lookup, not
  per session count; no scan cost concern for a deleter, but a duplicate id across project dirs is
  a hard error you should surface rather than half-fix.
- **The projection-cache domain is a live in-memory table** shared by the app: bypassing it (raw
  `rm` of `<id>.json`) leaves `recordFor`/`cachedSnapshot` serving the deleted row for the rest of
  the process lifetime, and `dsh-session-projection-cache` writes whole records back on the next
  checkpoint — which can **resurrect the file**. Always go through
  `ctx.storageDomain.get("session_projcache").table("sessions").delete(id)`.
- **`workspace.json` writes are serialised through the registry's operation chain**
  (`enqueueOperation`, `:774-781`) with a `pendingMutation` recovery marker in the global
  (`workspaceDomainState`, `:240`); a second writer (the `storage-domain` table write chain,
  `:257-287`) races with it. Do not write that file out-of-band.

---

## 7. Open questions / risks

1. **No way to close a live session from a third-party plugin.** The detach disposer produced by
   `ctx.sessions.enter()` (`dsh-session/lib/index.js:1428-1458`) is held only by
   `agentLoop.prepare`'s owner effect (`dsh-agent-loop/lib/index.js:1681-1690`) and returned to the
   `agentLoop.create/resume` caller. Nothing maps a session id to that disposer. Therefore a
   plugin can only (a) refuse to delete live sessions, or (b) ask the user to close/restart them.
   Whether DSH intends to add a `session/close` remote is unknown from the shipped code — the
   Remote list (`dsh-api-session-controller/lib/index.js:2499-2514`) contains none today.
2. **`archivedSessionIds` has no removal path** and is never pruned (§3.1). A hard delete leaves an
   orphan id there permanently. Whether that ever matters depends on whether ids can be reused —
   they are UUIDs in practice, so the practical risk is low; a future `unarchive` API would need to
   tolerate ids with no session.
3. **Legacy projection-cache bootstrap edge case.** `session_projcache.json` still lists ids that
   have no per-record document. It is inert *while at least one* per-record document exists; if a
   user deletes the last session (and its cache doc), the next open re-seeds every record from the
   legacy file, resurrecting cache rows for deleted session ids. Those rows are then discarded at
   read time only if the header identity disagrees — and for a genuinely absent session, nothing
   reads them at all (`list()` enumerates from the filesystem, not the cache). Rated *cosmetic*,
   but a "delete everything" feature should also retire/neutralise the legacy file.
4. **`session.lock` on POSIX**: not present on Windows, but a cross-platform plugin must delete
   the whole directory (which covers it). Removing a *held* lock file forfeits exclusion on POSIX
   (documented at `:625-630`) — irrelevant to Windows, notable if the plugin is portable.
5. **Attachments refcounting**: `~/.dsh/attachments/v1` does not exist here, so the layout could
   not be confirmed beyond `dsh-attachment-local/lib/index.js:986`. If images are used, a hard
   delete will orphan content-addressed blobs with no per-session mapping in the path — verify
   before offering "free disk space" claims.
6. **Third-party history cache contract unverified.** `dsh-session-plugin-history-cache.json` is
   `{version:2, sessions:{<id>:{ts, history:[…], limit}}}` by observation, but its writer is not
   installed, so its schema/versioning is not enforced anywhere I could read. Treat the shape as
   observed-not-contractual.
7. **Not verified end-to-end**: no deletion was performed (reconnaissance only), so the claim
   "UI updates immediately after §5" is derived from code paths (forwarded-event allowlist +
   `handleSessionRemoved` + `refreshList`), not from an observed run.
8. **`dsh-session-query-sqlite` under a durable path** was not exercised (this install is
   `:memory:`/`openAt: never`). Its reconciliation is read-only-verified
   (`:650-706`) but a deployment with `openAt: startup` + a real file would add
   `<path>` (+ `-wal`/`-shm`) to the "derived, self-healing, no action needed" list; verify before
   shipping a checklist that assumes it is absent.

---

## 8. Appendix — reproduction commands

```powershell
# tree of the session store (read-only)
Get-ChildItem "C:\Users\nan ge\.dsh\sessions" -Force -Recurse -Directory | Select-Object -ExpandProperty FullName
Get-ChildItem "C:\Users\nan ge\.dsh\sessions" -Force -Recurse -File      | Select-Object FullName,Length

# multi-frame zstd decode of one real log (76 frames / 136 events for 6183afbc-…)
node research\tools\dump-frames.cjs "C:\Users\nan ge\.dsh\sessions\--D-Tools-dsh-session-delete--\6183afbc-376b-4c5f-907e-3e76e0e1cee5\session.v3.jsonl.zstd" 4

# first frame only (header line)
node research\tools\dump-session.cjs  "C:\Users\nan ge\.dsh\sessions\--D-Tools-dsh-session-delete--\6183afbc-376b-4c5f-907e-3e76e0e1cee5\session.v3.jsonl.zstd" 1

# is any log currently held open? (ShareMode.None succeeds ⇒ nobody holds a handle)
Get-ChildItem "C:\Users\nan ge\.dsh\sessions" -Recurse -File -Force | ForEach-Object {
  try { $fs=[System.IO.File]::Open($_.FullName,'Open','Read','None'); $fs.Close(); "NO-HANDLE $($_.Directory.Name)" }
  catch { "HELD      $($_.Directory.Name)" } }
```

Verified facts from those runs: 5 session dirs / 5 logs, each log the only file in its directory;
`6183afbc-…` = 179 378 compressed bytes → 76 zstd frames → 136 event lines; the parent session
`session-b7fdaf6c-…` is `delegationDepth: 0` with no `parentSession`, its three subagents carry
`origin:"subagent"`, `parentSession:"session-b7fdaf6c-…"`, `delegationDepth:1`; no log held open.
