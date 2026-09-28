# DSH plugin packaging, building, installation and loading

Research date: read from the local install of **dsh `0.1.5-rc.2` / DSH Desktop `2.0.13`**.
All findings are read-only observations. Nothing under `D:\Tools\DSH\` or `C:\Users\nan ge\.dsh\` was modified.

**Evidence legend**

- **[V]** = verified by reading the actual shipped source/artifact (file + line cited).
- **[I]** = inferred from verified facts, or from documentation prose; not directly executable-verified.
- **[U]** = unknown / could not verify with the artifacts available (stated explicitly).

**Artifacts consulted (all read-only)**

| Path | Role |
| --- | --- |
| `D:\Tools\DSH\DSH Desktop\resources\app\` | Desktop Electron app checkout (`dsh-plugin-desktop@2.0.13`) |
| `C:\Users\nan ge\.dsh\profiles\desktop\` | Active profile (`dsh-profile-desktop`) |
| `C:\Users\nan ge\.dsh\profiles\node_modules\` | Shared install module fallback (symlinks) |
| `…\resources\app\node_modules\dsh-community-market\` | Reference plugin **with full TypeScript source** (`src/`) |
| `…\resources\app\node_modules\dshmarket\` | Published third-party plugin (`dshmarket@1.38.1`) — the *other* market provider, and the only in-repo example of restart-free mounting |
| `…\resources\app\node_modules\@deepseek-ai\dsh-app-boot\` | Profile/manifest/boot loader (the authoritative implementation) |
| `…\resources\app\node_modules\@deepseek-ai\cordis-plugin-include\` | **The patch dialect** (`applyEntryPatches`) |
| `…\resources\app\node_modules\@deepseek-ai\cordis-plugin-loader\` | Cordis loader (row import/resolution) |
| `…\resources\app\node_modules\@deepseek-ai\dsh-client-modules\` | Node+browser halves of the `__DSH_BOOT__` client module system |
| `…\resources\app\node_modules\@deepseek-ai\dsh-client-hmr\` | Client bundle rebuild watcher + SSE channel |

---

## 0. Environment facts

**[V]**

- Node `v22.19.0` is on PATH; `pnpm` is on PATH (Desktop-managed runtime commands); `npm` is on PATH (`C:\nvm4w\nodejs\npm.ps1`).
- `dsh` **is** on PATH (`C:\Users\nan ge\AppData\Roaming\DSH Desktop\host-commands\desktop\generations\…\dsh.cmd`) — so `dsh plugin …` is usable from a terminal.
- `$env:DSH_HOME` is currently `C:\Users\nan ge\.dsh`. `@deepseek-ai/dsh-home-paths/lib/index.js:15` defines the override env var as `DSH_HOME` and `resolveDshHome()` (line 73) reads it. **[V]** A scratch home is therefore `.devhome` + `DSH_HOME` — the workspace already contains a sibling-created `.devhome/profiles/web/` profile.
- Profile layout (`C:\Users\nan ge\.dsh\profiles\desktop\`): `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `node_modules/`, `.dsh-market/`, `.dsh-module-fallback/`. **[V]**
- `C:\Users\nan ge\.dsh\profiles\node_modules\` is the **installation module fallback**: `dsh-community-market`, `dshmarket`, `dsh-plugin-desktop` are **symlinks** into `…\resources\app\node_modules\…`, and `@deepseek-ai` is a symlinked directory. These are written by `healProfilesModuleFallback` (`dsh-app-boot/lib/index.js:657-676`). **[V]**

> **Note on "the profile has installed plugins":** the *profile's own* `node_modules` (`profiles\desktop\node_modules`) contains only `.pnpm`, `@heeweelee` (empty), `.modules.yaml`, `.package-map.json`, `.pnpm-workspace-state-v1.json`. The visible plugins resolve through the **shared** `profiles\node_modules` fallback. **[V]**

---

## 1. Package contract

### 1.1 Canonical examples

`dsh-community-market/package.json` **[V]** (`…\node_modules\dsh-community-market\package.json`):

```jsonc
{
  "name": "dsh-community-market",            // line 2
  "version": "0.1.0-dev.0",                  // line 3
  "private": true,                           // line 4  (shipped in-box, not published)
  "type": "module",                          // line 20
  "main": "lib/index.js",                    // line 21
  "types": "lib/index.d.ts",                 // line 22
  "exports": {                               // lines 23-37
    ".":                { "types": "./lib/index.d.ts",              "default": "./lib/index.js" },
    "./client":         { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./contracts":      { "types": "./lib/contracts/index.d.ts",    "default": "./lib/contracts/index.js" },
    "./package.json":   "./package.json"
  },
  "dsh": {                                   // lines 38-49
    "client": {
      "inject": ["@deepseek-ai/dsh-client-locale", "…ui-layout", "…ui-renderer", "…ui-settings", "…ui-sidebar"],
      "platform": "web"
    }
  },
  "files": ["docs/**","lib/**","LICENSE","README.md","README.zh.md","README.i18n.yaml",
            "SECURITY.md","SECURITY.zh.md","SECURITY.i18n.yaml"],                     // lines 50-60
  "engines": { "node": "^22.19.0 || >=24.0.0" }                                     // lines 61-63
}
```

`@deepseek-ai/dsh-client-ui-jobs/package.json` **[V]** — the canonical **host + client** plugin shape:

```jsonc
{
  "name": "@deepseek-ai/dsh-client-ui-jobs",
  "version": "0.1.5-rc.2",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".":                { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client":         { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*":          "./src/*",
    "./package.json":   "./package.json"
  },
  "dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-locale",
                                  "@deepseek-ai/dsh-client-ui-conversation",
                                  "@deepseek-ai/dsh-client-ui-primitives"],
                       "platform": "web" } },
  "files": ["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts"],
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
}
```

`@deepseek-ai/dsh-base/package.json` **[V]** — the canonical **bundle** (host-only) shape:

```jsonc
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },          // lines 31-35
  "exports": { ".": {…}, "./cordis.patch.yml": "./cordis.patch.yml", "./src/*": "./src/*", "./package.json": "./package.json" },
  "files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"]
}
```

`dshmarket@1.38.1` **[V]** — a **published third-party** plugin carrying **both** declarations:

```jsonc
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "client": { "inject": ["@deepseek-ai/dsh-client-connection",
                                  "@deepseek-ai/dsh-client-runtime",   // ← stale, see §4.4
                                  "@deepseek-ai/dsh-client-locale",
                                  "@deepseek-ai/dsh-client-ui-settings",
                                  "@deepseek-ai/dsh-client-ui-theme"],
                       "platform": "web" } },
  "exports": { "./client": "./client/client.js", "./cordis.patch.yml": "./cordis.patch.yml", … },
  "files": ["lib","src","client","UPDATE-API-V1.md","cordis.patch.yml","LICENSE"] }
```

### 1.2 Field-by-field contract

#### `name` **[V]**

The **same string is used for four different identities**, so it must be exact:

1. npm package name (and the `dsh.profile.bundles` entry).
2. The `id` passed to `window.__ModuleLoader__.load({ id: … })` in the client bundle — `dsh-community-market/scripts/verify-client-loader.mjs:22` asserts `registration.id !== 'dsh-community-market'` fails. Every shipped client bundle confirms it (`@deepseek-ai/dsh-client-ui-jobs/lib/client.js:1-3`, `dshmarket/client/client.js:1`). **[V]**
3. The row-id derivation convention used by the dsh-market plugin console: `name.replace(/^@/,'').replace(/[^a-z0-9-]/gi,'-').toLowerCase()` (`dshmarket/lib/hot.js:443-446`) — i.e. `@heeweelee/dsh-session-plugin` ⇒ row id `heeweelee-dsh-session-plugin`. **[V]**
4. The market's blocked-name list: `dsh-plugin-desktop`, `dsh-plugin-desktop-beta`, `dsh-community-market` (`dsh-community-market/src/install/github.ts:10-14`, `src/install/service.ts:34-38`). **[V]**

Accepted name pattern (npm-installable path): `/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u` — **lowercase only** (`src/install/service.ts:26`, `src/install/github.ts:5`). `dsh-session-delete` matches. **[V]**

#### `version` **[V]**

For **market auto-install** the version must be an **exact stable semver** — `stableExactVersion()` requires `semver.valid(v) === v` **and** `semver.prerelease(v) === null` (`src/install/service.ts:246-250`, `src/install/github.ts:27-31`). `1.0.0-rc.1` is **rejected**. A local `file:`/`link:` install has no such constraint. **[V]**

#### `type`, `main`, `types` **[V]**

- `"type": "module"` on every shipped plugin. The Loader imports the host half with **native ESM `import()`** (`cordis-plugin-loader/lib/index.js:270-283`).
- `main: "lib/index.js"` is the host entry.
- `types` is only a TypeScript convenience; **nothing in the harness reads it**. Official packages use `lib/types/index.d.ts`; `dsh-community-market` uses `lib/index.d.ts`. Both work — pick one and keep `exports["."].types` consistent.

#### `exports` **[V]**

Four subpaths matter:

| Subpath | Who reads it | Required when |
| --- | --- | --- |
| `"."` | Cordis Loader row `name` (bare package specifier) — resolves via `exports["."]` | always (host half) |
| `"./client"` | `dsh-client-modules` `clientExportOf()` — `dsh-community-market`-side read of `pkg.exports["./client"]` (`dsh-client-modules/lib/index.js:155-165`) | whenever `dsh.client` is declared — throws otherwise: ``client-modules: ${pkgName} declares dsh.client but exports no "./client" bundle`` (`:655`) |
| `"./cordis.patch.yml"` | optional; the loader resolves the **filesystem path** `join(packageDir, dsh.bundle.patch)`, not the export map (`dsh-app-boot/lib/index.js:851-853`) | not required, but present on `dsh-base`, `dsh-web-app`, `dshmarket` |
| `"./package.json"` | tooling / `createRequire(...).resolve('<pkg>/package.json')` | strongly recommended |

`clientExportOf` accepts either a **string** or an **object with a string `default`** (`:157-165`). `dshmarket` uses the bare string form `"./client": "./client/client.js"`; official packages use the conditional form. **[V]**

#### `files` **[V]**

`files` is the npm tarball allowlist and *is* the plugin's runtime surface. Two proven shapes:

- **Official plugin:** `["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts"]`.
- **`dsh-community-market`:** `["docs/**", "lib/**", "LICENSE", "README.md", "README.zh.md", "README.i18n.yaml", "SECURITY.md", "SECURITY.zh.md", "SECURITY.i18n.yaml"]`.

A bundle additionally ships its `cordis.patch.yml`. A plugin that ships `src/` (like `dsh-community-market`, `dshmarket`) must include it explicitly.

#### `dsh` — the Harness manifest block

The authoritative type module is `@deepseek-ai/dsh-package-manifest`, described in its own README as *"供启动器、客户端、构建工具和外部包共同使用的 `package.json.dsh` 元数据 TypeScript 声明"* and stating that **`DshManifest` describes `bundle`, `profile`, `client`, `configTrees`, `sessionFormatMigration` and `moduleFallback`** (`@deepseek-ai/dsh-package-manifest/README.zh.md:40`, `package.json:3`). **[V]** That package ships only an 11-byte `lib/index.js` and **no** `src/` or `lib/types/` in this install, so the field set below is reconstructed from its **consumers**, which is stronger evidence anyway. **[V]**

##### `dsh.client` — browser half registration **[V]**

Parser: `dsh-client-modules/lib/index.js:139-154` (`parseDshClient`), applied at `:648-655`.

| Key | Type | Semantics |
| --- | --- | --- |
| `platform` | **string, required** | Only `"web"` is honoured: `if (decl === void 0 \|\| decl.platform !== "web") return null` (`:650`). Missing ⇒ `dsh.client.platform must be a string` (`:144`). |
| `inject` | `string[]`, optional | Sibling package names that must be **arrived before** this row's factory runs: `for (const packageName of row.inject) { const dependency = this.graphRows.get(packageName); if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited) }` (`dsh-client-modules/lib/client.js:265-268`). A name with **no graph row is silently ignored** — it is an ordering hint, not a requirement. |
| `external` | `string[]`, optional | Specifiers this bundle `require()`s and expects the browser module table to answer. Drives graph ordering (`orderByModuleGraph`, `lib/index.js:349-371`) and pre-arrival (`lib/client.js:259-264`). `<pkg>/client` and `<pkg>` are the same row (`stripClientSuffix`, `lib/index.js:53-62`). A `require()` of something that is neither a seed word, a materialized module, nor a registered package factory throws `require("…") missed the module table …` (`lib/client.js:308`). |
| `immediately` | `boolean`, optional | Forces the bundle into the parser bootstrap batch before the Vite shell (`lib/index.js:374-376`, `:335`). `@deepseek-ai/dsh-client-modules` is the only shipped user (`package.json:36`). |

Both `inject` and `external` are validated: a malformed (non-string-array) value throws `dsh.client.inject must be an array of strings` (`optionalStringArray`, `lib/index.js:39-52`). **[V]**

##### `dsh.bundle.patch` — the host half's profile layer **[V]**

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Consumed in exactly three places:

1. **Bundle resolution at boot** — `resolveBundleDir()` then `JSON.parse(...).dsh?.bundle?.patch`, throwing `profile bundle "<name>" declares no dsh.bundle in its package.json` when absent (`dsh-app-boot/lib/index.js:849-853`). Same check for Desktop profiles at `lib/profile-39RdjuE6.js:448-450`.
2. **The market's npm verifier** — `createNpmRegistryVerifier` requires a valid `dsh.bundle.patch` on the official npm `latest` manifest, else `The npm package does not declare a valid DSH bundle.` (`src/install/service.ts:310-319`). This is a **hard gate for market auto-install**.
3. **The market's GitHub verifier** — the same requirement on the pinned-commit `raw.githubusercontent.com` manifest (`src/install/github.ts:88-95`).

Path safety rule (`safeBundlePatch`, `src/install/service.ts:268-275` — identical copy in `github.ts:33-40`):

> non-empty, ≤ 512 chars, no NUL, no leading `/`, no `\`, no `:` in any segment, every segment non-empty and not `.`/`..`; a leading `./` is stripped before validation.

So `./cordis.patch.yml` is valid; `../x.yml`, `C:/x.yml` and `cordis\patch.yml` are not.

##### `dsh.profile` — **profile-manifest-only** **[V]**

This key exists **only on a profile's own `package.json`**, never on a published plugin. A grep for `"profile"`/`"bundles"`/`patchReload` across every `package.json` under `…\resources\app\node_modules` returns **no matches** **[V]**, while the active profile has:

```jsonc
// C:\Users\nan ge\.dsh\profiles\desktop\package.json
{ "name": "dsh-profile-desktop", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
                        "patchReload": "live" } } }
```

| Key | Semantics | Evidence |
| --- | --- | --- |
| `bundles` | Ordered list of **bundle** package names whose `cordis.patch.yml` layers compose the tree. Each must resolve to a package declaring `dsh.bundle.patch`, or boot **fails loud**. | `dsh-app-boot/lib/index.js:845-860`, `lib/profile-39RdjuE6.js:320-335`, `:423-462` |
| `patchReload` | `"live"` \| `"startup"`. Anything else throws `dsh.profile.patchReload must be "live" or "startup"`. Custom profiles default to `"live"`. | `dsh-app-boot/lib/index.js:846-848`; `lib/profile-39RdjuE6.js:426-428` |

`bundles` is also validated at the boundary: `!Array.isArray(bundles) \|\| bundles.length > 1024 \|\| bundles.some(b => !safePackageName(b))` ⇒ `active profile manifest dsh.profile.bundles is invalid` (`lib/desktop-plugins-BcHrBm--.js:98-107`). **[V]**

##### `dsh.moduleFallback` — launcher-generated, **never author-set** **[V]**

`ensureModuleProxy` writes proxy packages whose manifest carries `dsh.moduleFallback.targets` (`dsh-app-boot/lib/index.js:548-579`); `readModuleProxyRecord` consumes it (`:399-405`), and `ensureSymlink` refuses to replace a non-symlink directory unless it is a dsh-managed proxy (`:414-419`). The `dsh-package-manifest` README states explicitly: *"`moduleFallback` 是启动器生成的元数据，不是作者配置项"* (`README.zh.md:40`).

##### `dsh.configTrees`, `dsh.sessionFormatMigration` **[V, not relevant]**

Mentioned by `README.zh.md:40` as part of `DshManifest`. No consumer is present in this install for a third-party plugin; both are declared out of scope for a normal plugin ("`configTrees` 服务于实验性镜像打包器，`sessionFormatMigration` 仅从工作区迁移包中发现；声明它们不会注册外部插件行为", `README.zh.md:75`). **Do not set them.**

### 1.3 The client bundle runtime contract (separate from `package.json`) **[V]**

`lib/client.js` **must** be a single classic script that calls the pre-existing global module loader exactly once:

```js
window.__ModuleLoader__.load({
  id: "<the package name>",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    /* … bundle body: `require("react")`, `require("@deepseek-ai/dsh-client-ui-settings")`, … */
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
```

Evidence: `dsh-community-market/tsdown.config.ts:31-36` emits exactly this `banner`/`footer`/`intro`; `dsh-community-market/scripts/verify-client-loader.mjs:6-24` asserts one registration with the expected `id` and a function `factory`; shipped bundles confirm the shape byte-for-byte at `@deepseek-ai/dsh-client-ui-jobs/lib/client.js:1-7` and `dshmarket/client/client.js:1-6`. **[V]**

The harness serves it from `/plugins/<id>/client.js` (+ `.map`) and combo-loads under `/plugins/??…&rev=<12-hex>`; the revision is `framedHash("plugin-artifact", [bundle, sourceMap])` (`dsh-client-modules/lib/index.js:178-183`). **[V]**

Hard constraints:

- **No code splitting / no dynamic `import()` of your own chunks.** The module table's `makeRequire` is synchronous; the factory form "cannot deliver partial exports" (`lib/client.js:278`). One file.
- **Never inline React or a `@deepseek-ai/dsh-client-*` platform module** — mark them `external` in the bundler *and* list the owning packages in `dsh.client.inject`.
- `@deepseek-ai/dsh-client-store` is the shared store engine; `verify-client-loader.mjs:31-36` explicitly fails the build if the market "bundled a private store engine instead of using the alpha platform module".

---

## 2. Build toolchain

### 2.1 The reference package's script pipeline **[V]**

`dsh-community-market/package.json:64-73`:

```jsonc
"scripts": {
  "build": "node scripts/clean.mjs && yarn run generate:types && tsdown && tsc -p tsconfig.json && tsc -p tsconfig.client.json --emitDeclarationOnly",
  "generate:types": "node scripts/generate-contract-types.mjs",
  "typecheck": "node scripts/generate-contract-types.mjs --check && tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.tests.json --noEmit",
  "test": "vitest run",
  "verify:contracts": "node scripts/generate-contract-types.mjs --check",
  "verify:loader": "node scripts/verify-client-loader.mjs",
  "check": "node scripts/verify-docs.mjs && yarn run build && node scripts/verify-package-exports.mjs && yarn run verify:loader && yarn run typecheck && yarn run test",
  "prepack": "yarn run check"
}
```

**Division of labour — who produces what:**

| Artifact | Producer | Why |
| --- | --- | --- |
| `lib/index.js` + all `lib/**/*.js` (non-client) | **`tsc -p tsconfig.json`** | `tsconfig.json` has `outDir: "lib"`, `declaration: true`, `include: ["src/**/*.ts"]`, `exclude: ["src/client/**"]` (`tsconfig.json:6,10,22-23`). Plain `tsc` emit — no bundler. Also emits `lib/**/*.d.ts`. |
| `lib/client.js` + `.map` | **`tsdown`** | single config in `tsdown.config.ts`. |
| `lib/types/**/*.d.ts` (client declarations) | **`tsc -p tsconfig.client.json --emitDeclarationOnly`** | `tsconfig.client.json` sets `rootDir: "src"`, `outDir: "lib/types"`, `include: ["src/client/**/*.ts","src/client/**/*.tsx","src/api-types.ts"]`, `exclude: []` (`tsconfig.client.json:4-9`). This is why `exports["./client"].types` is `./lib/types/client/index.d.ts`, i.e. `lib/types` + `src`-relative path. |

`@deepseek-ai/dsh-client-ui-jobs` shows the same convention with a flatter types layout (`types: lib/types/index.d.ts`, client types at `lib/types/client/index.d.ts`). **[V]**

### 2.2 `tsdown.config.ts` — line-by-line **[V]**

`dsh-community-market/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown'
const PACKAGE_NAME = 'dsh-community-market'
export default defineConfig({
    name: `${PACKAGE_NAME}/client`,          // :6  rollup-ish config name (build log only)
    entry: { client: 'src/client/index.ts' },// :7  → lib/client.js
    tsconfig: 'tsconfig.client.json',        // :8  reuse the client compiler options (jsx: react-jsx, DOM lib)
    outDir: 'lib',                           // :9
    format: 'cjs',                           // :10 browser half is CommonJS-in-a-factory
    platform: 'browser',                     // :11
    target: 'es2022',                        // :12
    fixedExtension: false,                   // :13 → `client.js`, NOT `client.cjs`
    dts: false,                              // :14 declarations come from tsc
    clean: false,                            // :15 never wipe tsc's output
    sourcemap: true,                         // :16 → client.js.map (required: the rev hashes both)
    external: [ 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
                '@deepseek-ai/cordis',
                '@deepseek-ai/dsh-client-locale/client',
                '@deepseek-ai/dsh-client-store',
                '@deepseek-ai/dsh-client-ui-layout/client',
                '@deepseek-ai/dsh-client-ui-primitives',
                '@deepseek-ai/dsh-client-ui-settings/client',
                '@deepseek-ai/dsh-client-ui-sidebar/client',
                '@deepseek-ai/dsh-client-ui-slots' ],          // :17-30
    outputOptions: {
      entryFileNames: 'client.js',                                        // :32
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,  // :33
      footer: 'return module.exports; } });',                              // :34
      intro: 'var module = { exports: {} }; var exports = module.exports;',// :35
    },
})
```

**Key answers**

- **Is client source bundled with React externalized?** *Yes.* `format: 'cjs'` produces a single CJS module; React, `react/jsx-runtime`, `react-dom` and every `@deepseek-ai/dsh-client-*` platform module are in `external:` (lines 17-30), so they appear verbatim as `require("react")` etc. inside the factory. Only *your* source plus third-party non-platform libs are inlined. **[V]**
- **Client build target/externals:** `platform: 'browser'`, `target: 'es2022'`, `format: 'cjs'`, `fixedExtension: false`. **[V]**
- **`react/jsx-runtime` must be external separately from `react`** — otherwise the JSX runtime is inlined and the page gets a second React copy. `@deepseek-ai/dsh-client-ui-jobs/lib/client.js:7-8` shows both `require("react/jsx-runtime")` and `require("react")`. **[V]**
- **`external` here is the *build* external list.** It must be a superset of the `require()`s the factory performs, and the packages named must be present as graph rows (via `dsh.client.inject`) or seed words. The two lists in `package.json` (`dsh.client.inject`) and `tsdown.config.ts` (`external`) are deliberately kept in sync by hand. **[V, with [I] for "kept in sync by hand"]**

### 2.3 `tsconfig.json` / `tsconfig.client.json` / `tsconfig.tests.json` **[V]**

`tsconfig.json` (host/base):

```jsonc
{ "compilerOptions": {
    "target": "ES2024", "lib": ["ES2024","DOM"], "module": "NodeNext", "moduleResolution": "NodeNext",
    "jsx": "react-jsx", "rootDir": "src", "outDir": "lib", "declaration": true, "esModuleInterop": true,
    "strict": true, "exactOptionalPropertyTypes": true, "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true, "noUncheckedIndexedAccess": true, "noUnusedLocals": true,
    "noUnusedParameters": true, "verbatimModuleSyntax": true, "types": ["node"] },
  "include": ["src/**/*.ts"], "exclude": ["src/client/**"] }
```

`tsconfig.client.json`:

```jsonc
{ "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types", "skipLibCheck": true },
  "exclude": [], "include": ["src/client/**/*.ts","src/client/**/*.tsx","src/api-types.ts"] }
```

`tsconfig.tests.json`: same base, `rootDir: "."`, `noEmit: true`, includes `src/**` + `tests/**`. **[V]**

**Note the `DOM` lib in the *base* config.** It is there because the host half legitimately touches DOM-typed values; but the *client* half is only **type-checked** by `tsconfig.client.json`, never emitted by `tsc` (the build passes `--emitDeclarationOnly`). **[V]**

### 2.4 `vitest.config.ts` **[V]**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: {
  environment: 'node',
  include: ['tests/**/*.spec.{ts,tsx}'],
  setupFiles: ['./tests/setup.tsx'],
}})
```

Client-side component tests rely on `jsdom` + `@testing-library/react` being available as devDependencies (`package.json:257-264, 264`); the default environment stays `node` and a per-file `// @vitest-environment jsdom` (or config override) is the usual pattern. **[V for config; [I] for the per-file pattern]**

### 2.5 Minimal template for a plugin with host + client entry **[I]**

Derived from §2.1-2.4, minimised for a single-purpose plugin:

```
plugin/
├─ src/
│  ├─ index.ts            # host half (Cordis plugin: name/inject/apply or a Service class)
│  ├─ api-types.ts        # shared wire types (optional)
│  └─ client/
│     ├─ index.ts         # client half entry: exports { name, inject, apply }
│     └─ *.tsx
├─ tsconfig.json          # as §2.3 (exclude src/client)
├─ tsconfig.client.json   # as §2.3
├─ tsdown.config.ts       # as §2.2 (entry src/client/index.ts)
└─ package.json
```

```jsonc
// package.json scripts
"scripts": {
  "clean":     "node -e \"fs.rmSync('lib',{recursive:true,force:true})\"",
  "build":     "pnpm run clean && tsdown && tsc -p tsconfig.json && tsc -p tsconfig.client.json --emitDeclarationOnly",
  "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit",
  "dev":       "tsdown --watch",
  "test":      "vitest run"
}
```

Because the host half is emitted by `tsc` (not bundled), **every host-side runtime `import` must be a real, resolvable dependency** — which is exactly what `peerDependencies` + the profile's module fallback provide.

---

## 3. Profile wiring and how a plugin is actually loaded

### 3.1 The profile files **[V]**

`C:\Users\nan ge\.dsh\profiles\desktop\package.json`

```jsonc
{ "name": "dsh-profile-desktop", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
                        "patchReload": "live" } } }
```

Note: **no `dependencies` key at all** (line 2-3), because nothing is currently pnpm-installed into the profile.

`cordis.yml` — one line: `[]` (line 1). This is the **root include target**; it is *always* rewritten at boot:

- CLI: `PROFILE_ROOT_CONFIG` = a comment header + `[]`, force-written by `prepareProfile` (`@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:124-130, 209`).
- Desktop: `writeFileSync(rootConfig, "[]\n")` (`lib/profile-39RdjuE6.js:690-692`), where `DESKTOP_PROFILE_ROOT = "cordis.yml"` (`:173`).

The comment in the CLI version states the reason verbatim: *"The tree is composed as patches … Edit `cordis.patch.yml`, not this file."* (`profile-boot-Dk-7KqJc.js:124-127`).

`cordis.patch.yml` — the **user patch layer**, template at `dsh-app-boot/lib/index.js:360-364`:

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

`pnpm-workspace.yaml` (`dsh-app-boot/lib/index.js:365-370`, reconciled on every load by `reconcileProfilePnpmWorkspace`, `lib/profile-39RdjuE6.js:350-372`):

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

`pnpm-lock.yaml` carries `settings.autoInstallPeers: false`; the Desktop's dependency-migration guard checks `lockfile.settings.autoInstallPeers === false` **and** `node_modules/.modules.yaml` with `nodeLinker === "hoisted"` + `packageManager` major ≥ 10 + matching `virtualStoreDirMaxLength` (`lib/profile-39RdjuE6.js:386-406`). If either drifts, the Desktop forces a migration on next boot.

### 3.2 The exact discovery/apply mechanism **[V]**

CLI surface — `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js`:

```
runProfile (line 279)
 └─ composeProfile (232)
     ├─ prepareProfile (206) → loadProfile(NAME, name, INSTALL_ANCHOR, …)   # app-boot:886
     │    └─ loadProfileDirectory (app-boot:843)
     │         ├─ manifest.dsh.profile.bundles                                 # :845
     │         ├─ for each bundle: resolveBundleDir → dsh.bundle.patch → loadOverlayPatches  # :849-860
     │         └─ profile/cordis.patch.yml → loadOverlayPatches                # :861-862
     ├─ loadOptionalPatches($DSH_HOME/cordis.patch.yml)                        # :238
     ├─ loadOverlayPatches(--patch …)                                          # :239
     └─ composeEntries([bundles, profile, home, overlays])                     # :242-247
 └─ boot(NAME, rootConfig, allPatches(composed), …)                            # :311
 └─ if patchReload === 'live': create timer+hmr, watchUserPatches(profile), watchUserPatches(home)  # :321-338
```

Desktop surface — `lib/host-process-entry.js:55`:

```js
const ctx = await boot(DESKTOP_PACKAGE_NAME, prepared.rootConfig, prepared.patches, async (hostCtx) => { … }, prepared.bareModuleBaseUrl)
```

where `prepared` comes from `prepareDesktopProfile(...)` (`lib/profile-39RdjuE6.js:682-932`, called at `lib/main.js:4407`), and `prepared.patches` is composed as (in order, `:743-748`, `:770`, `:785`, `:792`, `:806-815`, `:826-833`, `:839-860`, `:866-892`, `:899-910`):

1. `bundlePatches` — the `cordis.patch.yml` of every bundle in `dsh.profile.bundles`, in list order, with `@deepseek-ai/dsh-plugin-desktop`'s own `cordis.patch.yml` spliced in **immediately after** `@deepseek-ai/dsh-web-app` (`:701-714`).
2. `providerPatches` — the selected market provider's canonical row (`:725-742`).
3. `filteredProfile.patches` — the profile's `cordis.patch.yml`.
4. `filteredHome.patches` — `$DSH_HOME/cordis.patch.yml`.
5. Launcher-owned overrides appended last (settings, web-runtime, ui-layout/sidebar/conversation, agent-presets roots, win32 picker/pwsh-sandbox, webserver, telemetry, desktop-shell).

So the precedence chain is: **bundle layers (in `bundles` order) → provider → profile patch layer → `$DSH_HOME` patch layer → launcher overrides in `patches` order (last write wins per row)**. Note that the CLI inserts `--patch` overlays *after* the home layer (`profile-boot:213-219`), while the Desktop has no `--patch` equivalent.

### 3.3 The patch-entry schema — `PatchOptions` **[V]**

The semantics are one function: `applyEntryPatches` in `@deepseek-ai/cordis-plugin-include/lib/index.js:57-106` (byte-identical copy inlined at `dsh-app-boot/lib/index.js:59-108`). Parsing is `parsePatchList` (`dsh-app-boot/lib/index.js:1192-1204`): the file must be a **top-level YAML array of mappings**, parsed with `yaml.JSON_SCHEMA.extend(JsExpr)` so `!!js <expr>` scalars survive as `{ __jsExpr }` nodes (`cordis-plugin-include/lib/index.js:15-28`), and `anchorInsertedPluginNames` rewrites relative/absolute `insert[].name` to `file://` URLs anchored at the patch file's directory (`dsh-app-boot/lib/index.js:1169-1178`).

Three patch shapes:

```yaml
# 1. INSERT without id — append rows to the root list (the classic bundle patch)
- insert:
    - id: dsh-market
      name: 'dshmarket'

# 2. INSERT with id — append rows into the `config` array of an existing GROUP entry
- id: some-group
  insert:
    - id: my-row
      name: 'my-plugin'

# 3. ID-TARGETED OVERRIDE — mutate an existing entry in place
- id: hmr
  disabled: false
  config: { root: ['.'] }
```

Mechanics, quoted from the source:

- `const { id, insert, name, ...overrides } = patch` (`:69`) — everything except `id`, `insert` and `name` is an **override key**.
- Insert-with-`id`: the target must exist (`patch insert: entry %C not found`) **and** be a group (`patch insert: entry %C is not a group`), then `target.config.push(...insert)` (`:71-85`).
- Insert-without-`id`: `data.push(...insert)` (`:83`).
- Override without `id`: `patch: id is required for non-insert patches` (`:87-90`).
- Override with a wrong `id`: `patch: entry %C not found` — a **warning**, not a fatal error, so one overlay can target several surfaces (`:91-95`).
- `name` is a **guard**: `if (name && name !== target.name) warn('patch: name mismatch for %C …')` and the patch is skipped (`:96-99`). This lets you rename a row safely.
- `id` itself can never be overridden (`if (key === "id") continue`, `:101`).
- Any unmatched top-level patch == warning + skip; but an **unparsable or non-array patch file is fatal at boot** — *"a present patch file that cannot apply is a misconfiguration and must fail loud at boot, never be silently skipped"* (`dsh-app-boot/lib/index.js:1130-1136`).
- Later patches in the same flattened list can target rows an earlier patch inserted (`buildMap(insert)`, `:84`; doc comment `:49-51`).

**Real-world examples in this install**

`dshmarket/cordis.patch.yml` (whole file, 4 lines) — the minimal published bundle patch:

```yaml
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: dsh-market
      name: 'dshmarket'
```

`…\resources\app\cordis.patch.yml` (the Desktop app's own bundle patch) — mixes insert, `!!js` platform gating, and id-targeted override. This is the best real model to copy:

```yaml
- insert:
    - id: desktop-shell
      name: dsh-plugin-desktop
      config:
        mode: compatibility
    - id: desktop-terminal
      name: dsh-plugin-desktop/terminal
      disabled: !!js process.platform === 'linux'
    …
- id: web-runtime
  config:
    openBrowser: false
    printUrl: false
    surfaceContext: true
    trustedHosts: []
```

`@deepseek-ai/dsh-base/cordis.patch.yml` — one giant `- insert:` of ~200 rows, with the semantics documented in its header (lines 1-13) and a concurrency hint at lines 19-25:

```yaml
    # Module reload is opt-in per profile. `patchReload: live` config watching
    # uses the launcher's watch-only fallback and does not require this row.
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']
```

### 3.4 Row `name` resolution (how a string becomes a module) **[V]**

`@deepseek-ai/cordis-plugin-loader/lib/index.js:270-284`:

```js
import(name, getOuterStack) {
  if (name.startsWith("cordis:")) return this.ctx.loader.builtins[name.slice(7)];
  …
  if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
  else if (name.startsWith(".")) return await import(new URL(name, this.ctx.baseUrl).href);
  else return await import(name);
}
```

- `cordis:include`, `cordis:group` are builtins (`mountRootInclude`, `dsh-app-boot/lib/index.js:1322-1342`).
- Relative/absolute/`file:` names resolve against the tree's `baseUrl`, which the root include sets to the **profile directory** (`Include` constructor: `this.ctx.baseUrl = new URL(".", pathToFileURL(this.filename)).href`, `cordis-plugin-include/lib/index.js:138`). On the Desktop plain-Node path `loader.internal` is `undefined` (explicitly: `hostCtx.loader.internal = void 0`, `lib/host-process-entry.js:56`), so `name.startsWith(".")` → `new URL(name, baseUrl)`; a `file://` URL passes straight through to `import()`. **[V, with [I] for the exact `file://`-vs-internal branch on the packaged runtime]**
- **Bare names** resolve through Node from the profile: the Desktop passes `bareModuleBaseUrl = pathToFileURL(join(profile.dir, "package.json"))` as the include's `baseUrl` for bare specifiers (`profile-39RdjuE6.js:691`; used at `host-process-entry.js:55,181`). Node's ordinary parent-walk from `profiles/desktop/package.json` therefore reaches `profiles/desktop/node_modules/` → **`profiles/node_modules/`** (the shared fallback) → `…` — which is exactly how `dsh-community-market`, `dshmarket` and `dsh-plugin-desktop` resolve from the profile without being in the profile's `dependencies`.

`resolveBundleDir` uses the same two anchors explicitly: `[installAnchor, join(profileDir, "package.json")]` (`dsh-app-boot/lib/index.js:826-832`), with the error message *"run 'dsh plugin --profile <name> install' if its dependency is not installed"*.

The **profile module fallback** (`.dsh-module-fallback/node_modules/`) exists to give *bundle-carried but not installation-carried* dependencies to each profile: `healProfileModuleFallback` walks each bundle's dependency closure and links them into `<profile>/.dsh-module-fallback/node_modules/<dep>`, then a thin symlink at `<profile>/node_modules/<dep>` (never overwriting a pnpm-managed entry) — `dsh-app-boot/lib/index.js:711-738`, `ensureProfileSymlink` at `:450-462`. **[V]**

### 3.5 `patchReload: live` — what it actually covers

**Verified, CLI surface** (`@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:321-338`):

```js
if (composed.profile.patchReload === "live" && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {
  if (ctx.get("hmr") === void 0) {
    if (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
    await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
  }
  await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
  await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(),         compose: composeLive });
} catch (error) { suppressShutdownError(ctx, signalShutdown.signal, error); }
```

`watchUserPatches` (`dsh-app-boot/lib/index.js:1109-1129`) registers the **exact file path** with the Cordis HMR service; on change it re-parses the file, recomposes `composeLive()` (bundle patches + profile layer + home layer + overlays — `profile-boot:305-310`) and calls `entry.update({ config: { …includeConfig, patches } })` on the root include, which transactionally re-applies the whole patch list (`Include`'s `internal/update` handler, `cordis-plugin-include/lib/index.js:139-146`; `refresh()` at `:226-232`).

So **"live" covers exactly two YAML files**: `$DSH_HOME/profiles/<name>/cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml`. Insert / override / disable rows in those files take effect within ~1 s without a restart. It does **not** cover:

- editing a bundle's own `cordis.patch.yml` (bundle layers are read once at boot);
- editing a plugin's **host** JS (that is `@deepseek-ai/cordis-plugin-hmr`'s *module* reload, which `dsh-base` ships `disabled: true` by design — see `dsh-base/cordis.patch.yml:19-25`);
- adding a **new** package to `dsh.profile.bundles` (a new `dependencies` entry) — that needs a fresh resolution/boot.

**Desktop surface — important divergence.** **[V]** `lib/host-process-entry.js:55` calls `boot(...)` and **never** calls `watchUserPatches`; a case-insensitive search for `watchUserPatches`, `registerConfig`, `"hmr"` and `cordis-plugin-hmr` across every `*.js` under `…\resources\app\lib\` returns **no matches**. The only HMR-ish row in the composed Desktop tree is `client-hmr` (`@deepseek-ai/dsh-web-app/cordis.patch.yml:163-168`), which is the *client bundle* watcher, not the patch-file watcher. Therefore:

> **[V] On DSH Desktop, `patchReload: live` in the profile manifest is a value the launcher normalizes to match the upstream `web` template (`lib/profile-39RdjuE6.js:293-297, 324-325`), but the Desktop host does not install the patch-file watcher. Editing `cordis.patch.yml` requires a restart in the Desktop app.** This is consistent with the market's design, which issues a one-shot `restartToken` after every mutation (`dsh-community-market/src/install/service.ts:674-690`; `src/host/routes.ts:78, 1130-1158`) and with `docs/install-and-uninstall.md:68` — *"After a successful mutation, the user may restart now or later. Restart is never silent."*
>
> Running the **`dsh` CLI yourself** against the same home *does* get live patch reload. So the fast local dev loop is: `DSH_HOME=… dsh --profile <name>` (CLI, live) → edit `cordis.patch.yml` → see it apply; or run the Desktop and restart.

**What *is* hot in the Desktop, independent of `patchReload`:**

- **Client bundles.** `@deepseek-ai/dsh-client-hmr` stat-polls every graph row's `client.js` (default `pollIntervalMs: 500`) and pushes a `rebuilt` frame over the SSE channel `GET /plugins/events`; the browser half swaps the module. It is mounted unconditionally (`dsh-web-app/cordis.patch.yml:163-168`). Its own doc comment: *"The web bundle mounts this row unconditionally: without a rebuild watcher rewriting client bundles, the poll observes no changes and the chain stays idle."* (`dsh-client-hmr/lib/index.js:8-17`). So **rebuilding `lib/client.js` while Desktop runs is picked up live** — provided the row already exists in the boot graph.
- **Whole-plugin hot mount**, but only via the `dshmarket` provider, not the built-in `dsh-community-market` (see §3.6).

**[V]** `C:\Users\nan ge\.dsh\profiles\desktop\.dsh-market\log.ndjson` records exactly this behaviour for a real third-party plugin:

```json
{"at":"2026-09-24T01:04:46.101Z","level":"info","event":"install","detail":"desktop install boundary needs an exact version: @heeweelee/dsh-session-plugin -> @heeweelee/dsh-session-plugin@0.1.11"}
{"at":"2026-09-24T01:05:14.465Z","level":"info","event":"hot-mount","detail":"@heeweelee/dsh-session-plugin: live"}
{"at":"2026-09-24T01:05:14.491Z","level":"info","event":"install","detail":"@heeweelee/dsh-session-plugin exit=0 hot=true"}
{"at":"2026-09-24T01:20:37.242Z","level":"info","event":"toggle","detail":"@heeweelee/dsh-session-plugin -> off: fiber=false"}
{"at":"2026-09-24T01:20:37.243Z","level":"info","event":"uninstall","detail":"@heeweelee/dsh-session-plugin exit=0 live-removed=true"}
```

and `state.json` is `{"disabled":[],"groups":{},"groupOrder":[],"region":"global","regionAuto":true}` — **both files belong to `dshmarket`** (the `region`/`regionAuto` keys and the `hot-mount`/`live-removed` event names are `dshmarket`'s: `dshmarket/lib/hot.js:32, 368`; `lib/log.js:42`). **[V]**

### 3.6 The `dshmarket` hot-mount mechanism **[V]** (the only verified restart-free plugin activation)

`dshmarket/lib/hot.js:289-377`:

1. Import `@deepseek-ai/cordis-plugin-include` dynamically and subclass `Include` into `MarketHotTree`, overriding `write()` to a no-op (*"the loader otherwise persists tree changes back to the file it read"*, `:14-16, 64-71`). If the import fails ⇒ `宿主不支持热挂载 … restart required` (`:305`).
2. Read `readFileSync(join(profileDir,'node_modules',packageName,'cordis.patch.yml'))`. Its **strict line-wise** `parseSimplePatch` (`:95-128`) accepts **only** `- insert:` + `id`/`name` pairs and **returns `null`** for anything else, including CRLF-comment mishandling (see the comment at `:98-103`) ⇒ falls back to restart.
3. If there is **no** patch but the package declares `dsh.client` **and not** `dsh.bundle`, synthesise a **shim row** `{ id: 'client-<sanitized-name>', name: packageName }` whose import is replaced by `{ name, apply: () => {} }` (`:67-71, 326-339, 45-51`). *"client-modules only serves bundles for packages with a live loader entry — the shim fiber exists purely to satisfy that registration."*
4. Write `rows` as an ephemeral YAML file under `<profile>/.dsh-market/hot-<n>.yml` and mount it: `ctx.plugin(HotTree, { path: pathToFileURL(file).href })`, awaiting activation under a 10 s ceiling (`DSH_MARKET_HOT_MOUNT_TIMEOUT_MS`, `:39`).

`mountClientOnlyDeps` (`:385-413`) does the same at market startup for every direct dependency that is **not** in `dsh.profile.bundles` and declares `dsh.client` without `dsh.bundle` — unless the user's own `cordis.patch.yml` already manages it (`patchLayerManages`, `:405, 443-446`).

**Why this matters for our plugin:** `dshmarket`'s own README-of-record behaviour proves two portable facts:

- A plugin can be activated **live** by mounting an extra `cordis:include` subtree — no restart — but the *durable* activation is still the bundle layer / profile patch layer, and the ephemeral file is wiped every boot (`cleanHotDir`, `:129-135`).
- A **client-only** plugin (no `dsh.bundle`) is a legitimate shape, but it needs *someone* to insert a row for it — either the user's `cordis.patch.yml` or a market shim. `dsh plugin add` will **not** add it to `dsh.profile.bundles` (§3.7).

### 3.7 Loading an unpublished local plugin from a folder — the three options

**Option A — `dsh plugin add` with a path spec (durable, needs `dsh.bundle.patch`).** **[V]**

`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js` is *"profile plugin management as a thin pnpm forwarder"*: it inits the profile if missing (`:103-107`), runs `spawnSync("pnpm", args, { cwd: dir, shell: process.platform === "win32" })` (`:109-114`), then `reconcilePlugins` **adds the package to `dsh.profile.bundles` only if it declares `dsh.bundle`** (`:25-33, 52-59`); a bundle-less dependency produces:

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer
(a later update that gains one activates it automatically)
```

Crucially, relative path specs are **re-anchored to your invoking cwd** before pnpm sees them (`anchorPathSpec`, `:90-94`) — otherwise pnpm (cwd = the profile) would resolve `.` inside the profile:

```js
const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
if (match?.groups?.path === undefined) return argument
return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`
```

So, from `D:\Tools\dsh-session-delete`:

```powershell
# Desktop profile
dsh plugin --profile desktop add .\                 # or: add "file:D:\Tools\dsh-session-delete"
# Scratch dev profile (matches the existing .devhome)
$env:DSH_HOME = "D:\Tools\dsh-session-delete\.devhome"
dsh plugin --profile web add .\
```

**[I]** `file:` vs `link:`: `link:` is pnpm's symlink form. `anchorPathSpec` handles both, so either works mechanically; **use `link:` if you want edits to `lib/` to be visible without re-installing**, and `file:` if you want pnpm's copy semantics. `[U]` — I did not verify which directory form this pnpm version (11.8.0 per `resources\app\package.json:261`) materialises as a symlink for a `file:` directory spec.

**Option B — direct row in the user patch layer (no `dsh.bundle` needed; the fastest loop).** **[V]**

Because `anchorInsertedPluginNames` rewrites relative/absolute `insert[].name` to a `file://` URL anchored at the patch file's directory (`dsh-app-boot/lib/index.js:1169-1178`), and because the Cordis loader imports `file:` URLs directly (`cordis-plugin-loader/lib/index.js:270-283`), you can point at a folder with **no pnpm involvement at all**. Append to `C:\Users\nan ge\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- insert:
    - id: session-delete
      name: 'D:\Tools\dsh-session-delete\lib\index.js'
```

or, relative to the profile dir (`…\.dsh\profiles\desktop\`):

```yaml
- insert:
    - id: session-delete
      name: '../../../../Tools/dsh-session-delete/lib/index.js'
```

Requirements/caveats:

- **The `name` must point at the built host entry**, not at the package directory — `import()` needs a module, not a folder. **[V for the import path; [I] that a directory would fail]**
- Node's ESM cache means a **host-side** code change needs a restart; only the *client* half is hot (§3.5).
- The row is a plain loader row, so its `dsh.bundle` is irrelevant, but the client half still needs a `package.json` with `dsh.client` + `exports["./client"]` **reachable from the imported module** (`dsh-client-modules/locatePkgJson` walks up to the nearest package.json for `pathLike` names — `lib/index.js:679-708`).
- Row ids must be unique across the composed tree (`assertUniqueEntryIds`, `lib/profile-39RdjuE6.js:511-521`); a duplicate id is a **startup failure**.
- Needs a restart on Desktop (§3.5), immediate on the CLI.

**Option C — drop it in the shared fallback so a bare name resolves (best for `dsh.profile.bundles`).** **[V, mechanism]**

`C:\Users\nan ge\.dsh\profiles\node_modules\<pkg-name>` as a junction to your checkout makes `<pkg-name>` resolvable from **every** profile. This is exactly what the launcher itself does for `dsh-community-market` and `dshmarket`. Then either:

- `dsh plugin --profile desktop add <your-checkout>` (Option A, which also records the dependency), or
- hand-edit `dsh.profile.bundles` to append `dsh-session-delete` (valid only if the package declares `dsh.bundle.patch`).

Be aware `healProfilesModuleFallback` and `ensureSymlink` treat unknown non-symlink directories as a hard error (`dsh-app-boot/lib/index.js:414-419`) — a **junction/symlink** is fine, a copied directory is not.

### 3.8 Enabling / disabling without uninstalling **[V]**

`- id: <rowId>` + `disabled: true|false` in the profile patch layer (or `$DSH_HOME/cordis.patch.yml`) stops/force-enables exactly one loader entry — this is what `dshmarket/lib/patch.js:1-26` calls *"the official mechanism"*. Combined with live reload on the CLI, this is the toggle. For Desktop-managed third-party bundles there is also a Desktop-owned disable state (`dsh.profile.bundles` minus `.dsh-market/state.json`, `lib/desktop-plugins-BcHrBm--.js`), but it is **not** on `dsh.profile` and not something a published plugin should touch. Note the immutable-bundle list (`lib/desktop-plugins-BcHrBm--.js:26-31`): the `web` template bundles plus `@deepseek-ai/dsh-desktop-app`, the `dsh-plugin-desktop*` names, and `dsh-community-market` can never be disabled.

---

## 4. Publishing / market installability

### 4.1 npm path (the primary, automatic-install path) **[V]**

`docs/install-and-uninstall.md:20-38` + `src/install/service.ts:277-323` + `src/install/github.ts`:

| Requirement | Enforced where |
| --- | --- |
| Registry is **`https://registry.npmjs.org`** — hard-coded (`NPM_REGISTRY_ORIGIN`, `service.ts:24`); the install argv is `['add','--save-exact','--registry=https://registry.npmjs.org/', …]` with a scoped-registry flag for `@scope` packages (`installOptions`, `service.ts:881-888`). No other registry is reachable from the market. | `service.ts:24, 881-888` |
| The market fetches **`https://registry.npmjs.org/<name>/latest`** and requires `manifest.name === candidate.packageName` **and** an exact stable `manifest.version` | `service.ts:287, 307-309` |
| The `latest` manifest must declare a valid `dsh.bundle.patch` | `service.ts:310-319` ⇒ *"The npm package does not declare a valid DSH bundle."* |
| Destination origin must stay `registry.npmjs.org` (redirects rejected) | `service.ts:294-305` |
| Name must match the lowercase npm pattern and not be a blocked product package | `service.ts:26, 34-38, 252-254` |
| The **catalog entry** must normalise to exactly one npm package identity (a catalog item with only a GitHub target stays browsable but is not auto-installable) | `service.ts:511-513`; `docs/install-and-uninstall.md:33-40` |
| The **source's listed version is ignored** — npm `latest` is the version authority | `docs/install-and-uninstall.md:27` |

Post-install: `pnpm add --save-exact <name>@<ver>` (or `github:owner/repo#<sha>[&path:/<sub>]`) → `setProfileBundle(profile, packageName, true)` atomically rewrites `dsh.profile.bundles` → `directProfilePluginVersion` re-reads `dependencies[packageName]` and asserts it equals the verified version (`service.ts:626-665`, `setProfileBundle` at `:376-415`).

**Tarball layout = whatever `files` allows.** The host never inspects the tarball; it installs with pnpm and then reads `package.json` from `profile/node_modules/<name>/`. So the only layout requirements are: `dsh.bundle.patch` must exist **inside the installed package** and its path must pass `safeBundlePatch`. **[V]**

**[I] Practical publishing checklist for `dsh-session-delete`:**

1. `"version"` must be an **exact stable semver** at publish time (`1.0.0`, not `1.0.0-rc.1`) — the market rejects prereleases, and `dsh plugin add --save-exact` needs a real version.
2. `"name": "dsh-session-delete"` (unscoped is fine and matches the lowercase pattern; unscoped also avoids the scoped-registry argv branch).
3. Declare `dsh.bundle.patch: "./cordis.patch.yml"` and ship the file — without it the market says "does not declare a valid DSH bundle".
4. `"license"`, `"repository"`, `"description"` — `description` is what the market surfaces as the item summary; `repository.url` is what a catalog provider can normalise into an install source.
5. `publishConfig: { "access": "public", "registry": "https://registry.npmjs.org" }` — matches every shipped example.
6. `prepack`/`prepublishOnly` running the build+check (the reference package uses `"prepack": "yarn run check"`, `package.json:72`), so `lib/` can be gitignored-free and the tarball is always fresh.
7. `engines.node` — `"^22.19.0 || >=24.0.0"` matches `dsh-community-market` and the Desktop app.

### 4.2 GitHub path (no npm publish) **[V]**

`src/install/github.ts`:

- Source must be normalised to `{ owner, repo, commit }` with `commit` matching `/^[0-9a-f]{40}$/` and `owner`/`repo` matching `^[a-z0-9][a-z0-9-]{0,99}$`/`^[a-z0-9._-]{1,100}$` (`:8, 46-53`).
- The verifier fetches **`https://raw.githubusercontent.com/<owner>/<repo>/<commit>[/<subdirectory>]/package.json`** (≤ 1 MiB, `:9, 61-65, 100`), rejects any redirect/path change (`:82`), and applies the **same** rules as npm: valid package name, **exact stable version**, valid `dsh.bundle.patch` (`:84-96`).
- Install target is `github:<owner>/<repo>#<commit>[&path:/<subdirectory>]` (`:55-59`) — i.e. **pinned to a full commit SHA**, never a branch.
- `dsh plugin add` prints an actionable hint if pnpm blocks git build scripts (`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:126`): add the exact key to `allowBuilds` in `projects/<id>/pnpm-workspace.yaml`.

### 4.3 Manual fallback (display-only) **[V]**

`src/install/manual.ts:21-59` builds a *display-only* command from Host-normalised identity:

- npm: `dsh plugin add --save-exact <name>@<latestVersion>` (requires `package.registry === 'npm'`, npm-safe name, and `latestVersion` matching `/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/` — `:8, 23-34`).
- GitHub: `dsh plugin add github:<owner>/<repo>#<commit>[&path:/<sub>]` (`:37-52`).

**Provider-supplied command strings never enter this function or its result** (`:17-20`), and the docs stress the terminal button never pastes or executes it (`docs/install-and-uninstall.md:54`).

### 4.4 Catalog-entry expectations, and one trap **[V]**

A catalog item that reaches the Installable view must satisfy the `catalog-snapshot` schema (`src/contracts/generated/catalog-snapshot.ts:9-35, 80-91`): `id`, `name`, `displayName`, `summary`, `provenance{sourceRecordId,providerId,itemId}`, plus at least one of `repository {url, subdirectory?}` or `package {registry:'npm', name}`. Optional: `latestVersion`, `license`, `categories` (≤32), `keywords` (≤64), `homepage`, `installSource {kind:'github', commit}`, `publisher`, `media.icon`, `capabilities`, `compatibility {apiVersion?, hosts?}`. **[V]**

**The trap:** `dshmarket@1.38.1` declares `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", …]` (`package.json:29-33`) — but `@deepseek-ai/dsh-client-runtime` **does not exist** in `dsh 0.1.5-rc.2`. `verify-client-loader.mjs:34-36` in the reference plugin explicitly treats a request for it as a build failure (*"market client still requests the removed legacy client runtime"*). Because `inject` entries with no graph row are silently ignored (`dsh-client-modules/lib/client.js:266-267`), this is harmless at runtime — but its `lib/client.js` may still contain a hard `require("@deepseek-ai/dsh-client-runtime")` which would throw `missed the module table`. **Do not copy `dshmarket`'s inject list**; derive yours from the packages you actually `require()` and that are mounted as graph rows in the current `dsh-web-app/cordis.patch.yml` roster. **[V]**

---

## 5. House-style template files

### 5.1 `README.md` + `README.zh.md` + `README.i18n.yaml` **[V]**

Convention: **English is `README.md`, Chinese is `README.zh.md`, and `README.i18n.yaml` is a *Git-blob-hash pairing record*, not a translation file.**

Two observed variants of the record. The **Anywhere Labs / Desktop** variant (`dsh-community-market/README.i18n.yaml`, whole file):

```yaml
# Bilingual-pair consistency record. Both languages carry equal authority.
# Update both files and record their Git blob hashes after editing either side.
README.md: a2a6f6c72aac3ed072a4f2c6777cbd8855a5644b
README.zh.md: 00c4809f5069d40a791c4245749f5a68a785a9b1
```

The **upstream DeepSeek** variant adds the verifier command (`@deepseek-ai/dsh-app-boot/README.i18n.yaml`, whole file):

```yaml
# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
# side as of the last confirmed-consistent state. Both languages carry equal authority;
# after editing either side, bring the other along and re-record with:
#   pnpm run verify-translation-pairing --write packages/boot/app-boot/README.md
README.md: df386b64089f962960b09538381e9d4b4905feb0
README.zh.md: 5a7246c52ea5bcc8d5322d9fac4a87ec2e2ef4cc
```

Observable consequences:

- The record is **exhaustive**: every paired doc gets an entry. `dsh-community-market/docs/` has `catalog-adapter-guide.i18n.yaml`, `catalog-provider-contract.i18n.yaml`, `install-and-uninstall.i18n.yaml`, `market-shell.i18n.yaml` — one per `.md`/`.zh.md` pair.
- The Chinese file opens with a cross-link line: `[English](README.md) | 中文` (`dsh-package-manifest/README.zh.md:8`) or `[English](README.md)` (`dsh-community-market/README.zh.md:3`).
- Upstream READMEs carry a **YAML frontmatter block** before the H1:

  ```yaml
  ---
  description: "供启动器、客户端、构建工具和外部包共同使用的 package.json.dsh 元数据 TypeScript 声明。"
  kind: "package-library"
  ---
  ```
  (`dsh-package-manifest/README.zh.md:1-4`)

  and a fixed section skeleton in Chinese: `## 概述` → `## 目录` → `<a id="…"></a>` / `## 使用本包` → `## 理解实现` (inside `<details><summary>实现细节——点击展开</summary>`) → `## 进一步探索` → `## 模型体验` (with a `#### KV Cache 影响` subsection) → `## 已知限制与后续工作` → `### 开发备注`. The Anywhere Labs packages use a plainer skeleton: intro + blockquote disclaimer → `## 产品行为` → feature sections → `## 文档` with a link list.
- **[V]** Hash correspondence is real and checkable: `git hash-object` of the listed pair matches. (Spot-principle from the format; I did not run `git hash-object` on every pair.)
- **[V]** In this installed tree `dsh-community-market` ships `README.zh.md` **but not `README.md`**, while its `files` array lists both — an npm-packing artifact worth not replicating blindly; verify with `npm pack --dry-run`.
- `SECURITY.md` mirrors the same convention: `SECURITY.zh.md` + `SECURITY.i18n.yaml` (`dsh-community-market/SECURITY.i18n.yaml`, whole file):

  ```yaml
  # Bilingual-pair consistency record. Both languages carry equal authority.
  # Update both files and record their Git blob hashes after editing either side.
  SECURITY.md: ccda650dff63450e5e606f829d86d421812babb4
  SECURITY.zh.md: fd64e2de0a0b0ffb744f5f6a9b31d0ec8eb76562
  ```

### 5.2 `LICENSE` **[V]**

Bare MIT text, 21 lines, `Copyright (c) 2026 <owner>`, shipped in every package:

- `dsh-community-market/LICENSE:1-3` → `MIT License` / `Copyright (c) 2026 Anywhere Labs`
- `dshmarket/LICENSE:1-3` → `Copyright (c) 2026 fkysly and dsh-market contributors`
- `@deepseek-ai/*` packages all ship the identical 1065-byte MIT file.
- `package.json` carries `"license": "MIT"`.

### 5.3 `SECURITY.md` **[V]**

Required only when the package performs privileged operations. `dsh-community-market/SECURITY.md` (39 lines) uses: `# Security Policy` → `[中文说明](SECURITY.zh.md)` → `## Trust model` → `## Package-operation boundary` (a bulleted list of authority constraints) → `## Catalog sources` → `## Reporting a vulnerability` with a private contact and an explicit "do not open a public issue for an unpatched vulnerability" instruction. The **core rhetorical device** worth copying: an explicit disclaimer that a listing is *not* a security review, plus *"These rules constrain authority and identity. They do not make a third-party plugin safe."* A plugin with no privileged surface should simply omit `SECURITY.md`.

### 5.4 Other house conventions observed **[V]**

- `"keywords": ["deepseek", "dsh", "plugin", …]` (`dsh-community-market/package.json:273-279`).
- `"engines": { "node": "^22.19.0 || >=24.0.0" }` on the Desktop-side packages.
- `"publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" }`.
- Internal repo references use `git+https://github.com/…` with `"directory": "packages/<area>/<name>"`.
- Every published package ships `README.i18n.yaml` (430-440 bytes) even when it does not ship both READMEs.

---

## 6. Recommended scaffold for `dsh-session-delete`

Design decisions, each grounded in the sections above:

| Decision | Reason |
| --- | --- |
| Publish **unscoped** as `dsh-session-delete` | Matches the lowercase npm pattern (`§4.1`) and matches the working name. Scoped works too but adds a `--@scope:registry` argv branch. |
| Declare **both** `dsh.bundle.patch` and `dsh.client` | `dsh.bundle.patch` is a **hard gate** for market auto-install (`§4.1`) *and* makes `dsh plugin add` put the package into `dsh.profile.bundles` automatically (`§3.7` A). `dsh.client` supplies the UI. |
| Keep the **bundle patch to plain `id`/`name` inserts** | A plain-insert patch is the only shape the `dshmarket` hot-mount parser accepts (`§3.6`), so the plugin can activate without a restart there. Config blocks force a restart. |
| Ship a **client-only deletion UI** in `src/client/`, host logic in `src/index.ts` | Matches the dual-face convention of every `dsh-client-ui-*` package. |
| Host half emitted by **`tsc`**, client half by **`tsdown`** | The verified reference pipeline (`§2.1`). |
| `external` in tsdown == the platform modules listed in `dsh.client.inject` | The two lists must agree or the browser `require()` throws `missed the module table` (`§1.3`). |
| No `dsh.configTrees` / `dsh.sessionFormatMigration` | Out of scope for a plugin (`§1.2`). |

### 6.1 Proposed file tree

```
dsh-session-delete/
├─ src/
│  ├─ index.ts                     # host half: Cordis plugin (name / inject / apply or Service)
│  ├─ api-types.ts                 # wire types shared by both halves (recommended: declare the RPC face here)
│  ├─ session-delete.ts            # host logic (find + delete session logs under $DSH_HOME/sessions)
│  └─ client/
│     ├─ index.ts                  # client half entry: exports name / inject / apply
│     ├─ SessionDeleteAction.tsx    # React component
│     └─ locales.ts                # en / zh strings
├─ tests/
│  ├─ setup.ts(x)
│  └─ *.spec.ts(x)
├─ docs/                           # optional, only if you want paired docs
│  └─ …
├─ cordis.patch.yml                # bundle patch: plain id/name insert (hot-mountable)
├─ tsdown.config.ts
├─ tsconfig.json
├─ tsconfig.client.json
├─ tsconfig.tests.json
├─ vitest.config.ts
├─ package.json
├─ LICENSE                         # MIT, "Copyright (c) 2026 <you>"
├─ README.md                       # English
├─ README.zh.md                    # Chinese
├─ README.i18n.yaml                # git blob hashes of the pair
└─ .gitignore                      # node_modules/  lib/  dist/  *.log  .devhome/  .scratch/
```

### 6.2 `package.json`

```jsonc
{
  "name": "dsh-session-delete",
  "version": "0.1.0",
  "description": "Delete sessions from DSH Desktop — a session-list action with a confirmation dialog",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org" },
  "repository": { "type": "git", "url": "git+https://github.com/<you>/dsh-session-delete.git" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "keywords": ["deepseek", "dsh", "plugin", "session", "delete"],
  "exports": {
    ".":                  { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client":           { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./src/*":            "./src/*",
    "./package.json":     "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-primitives",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session"
      ]
      // add "@deepseek-ai/dsh-client-store" ONLY if you actually require() it
    }
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/**/*.js",                 // host half is many files (tsc, unbundled)
    "lib/types/**/*.d.ts",
    "cordis.patch.yml",
    "LICENSE",
    "README.md",
    "README.zh.md",
    "README.i18n.yaml"
  ],
  "scripts": {
    "clean":     "node -e \"require('node:fs').rmSync('lib',{recursive:true,force:true})\"",
    "build":     "pnpm run clean && tsdown && tsc -p tsconfig.json && tsc -p tsconfig.client.json --emitDeclarationOnly",
    "dev":       "tsdown --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit && tsc -p tsconfig.tests.json --noEmit",
    "test":      "vitest run",
    "prepack":   "pnpm run build && pnpm run typecheck && pnpm test"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-client-locale": "0.1.5-rc.2",
    "@deepseek-ai/dsh-client-ui-conversation": "0.1.5-rc.2",
    "@deepseek-ai/dsh-client-ui-primitives": "0.1.5-rc.2",
    "@deepseek-ai/dsh-client-ui-renderer": "0.1.5-rc.2",
    "@deepseek-ai/dsh-client-ui-session": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "0.1.5-rc.2",
    "@deepseek-ai/dsh-session-persistence": "0.1.5-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "peerDependenciesMeta": {
    // mark optional the ones a host may legitimately lack, exactly like dsh-community-market:126-199
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.2",
    "@types/node": "^22.20.0",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "jsdom": "29.1.1",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "tsdown": "0.22.2",
    "typescript": "^5.9.0",
    "vitest": "^4.1.0",
    "@testing-library/react": "^16.3.2",
    "@testing-library/dom": "^10.4.1"
  }
}
```

Notes:

- The plugin-local `package.json` here is untrusted metadata for the *host tree* to copy from. Use the **exact versions** the running Desktop ships (`…\resources\app\package.json:119-266`, dsh `0.1.5-rc.2`, `typescript` here is pinned at `6.0.3` in the reference package but `^5.9.0` is fine locally; `tsdown 0.22.2`, `vitest 4.1.8` are what the reference uses).
- Pin `@deepseek-ai/*` peers as **`^0.1.5-rc.2`** (the official convention, `@deepseek-ai/dsh-client-ui-jobs/package.json:39-54`) — those packages are on npm under `@deepseek-ai`, and `autoInstallPeers: false` in the profile means pnpm will **not** fetch them; they resolve through the install fallback. A wider range is safer for forward compatibility.

### 6.3 `cordis.patch.yml`

Keep it to a **plain insert** so `dshmarket` can hot-mount it (see the `parseSimplePatch` constraints in §3.6 — comments are tolerated, `config:`/`disabled:`/`!!js` are not):

```yaml
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
```

Row id `session-delete` must be **unique across the whole composed tree** (`assertUniqueEntryIds`, `lib/profile-39RdjuE6.js:511-521`) — a duplicate is a hard startup failure. Using the package name (or the market's derived convention) avoids collisions; `dsh-session-delete` derives to `dsh-session-delete`.

### 6.4 `tsdown.config.ts`

```ts
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-session-delete'

export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,   // emit client.js, NOT client.cjs
  dts: false,              // declarations come from tsc --emitDeclarationOnly
  clean: false,            // never wipe tsc's output
  sourcemap: true,         // required: the bundle rev hashes bundle + map
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
```

`tsconfig.json` / `tsconfig.client.json` / `tsconfig.tests.json` / `vitest.config.ts` — copy `dsh-community-market`'s verbatim (§2.3, §2.4), changing only `include` paths. Keep `exclude: ["src/client/**"]` in `tsconfig.json` so the host `tsc` run cannot emit into `lib/client.js`.

### 6.5 Exact local-load procedure

Work from `D:\Tools\dsh-session-delete`. `dsh` and `pnpm` are already on PATH.

**Step 0 — build.**

```powershell
pnpm install
pnpm run build
# expect: lib/index.js (+ siblings), lib/client.js, lib/client.js.map,
#         lib/types/**/*.d.ts, lib/types/client/index.d.ts
```

Sanity-check the client bundle contract before touching any profile:

```powershell
# must print exactly one `window.__ModuleLoader__.load({` with id "dsh-session-delete"
Select-String -Path .\lib\client.js -Pattern '__ModuleLoader__\.load'
# must NOT contain an inlined React
Select-String -Path .\lib\client.js -Pattern 'require\("react'
```

**Step 1 — a scratch profile that cannot break the real one.** `.devhome/profiles/web/` already exists in this workspace (a `web`-template profile). Use it first:

```powershell
$env:DSH_HOME = "D:\Tools\dsh-session-delete\.devhome"
dsh --profile web --dump-config        # optional: see the composed tree before booting
```

**Step 2 — install as a `file:`/`link:` dependency (durable; auto-adds the bundle layer because we declare `dsh.bundle.patch`).**

```powershell
$env:DSH_HOME = "D:\Tools\dsh-session-delete\.devhome"
dsh plugin --profile web add "link:D:\Tools\dsh-session-delete"
```

`dsh plugin` re-anchors the spec to your cwd, runs `pnpm add` with `cwd` = `…\.devhome\profiles\web`, then reconciles `dsh.profile.bundles` (`@deepseek-ai/dsh/lib/plugin-Ddi42qoW.js:90-129`). Verify:

```powershell
Get-Content "$env:DSH_HOME\profiles\web\package.json"
#   dependencies["dsh-session-delete"] present, AND
#   dsh.profile.bundles ends with "dsh-session-delete"
```

**Step 3 — the zero-install variant, if you only want to iterate on the host half.** Put the row *directly* at the source of truth instead of installing:

```powershell
$p = "$env:DSH_HOME\profiles\web\cordis.patch.yml"
@"

- insert:
    - id: session-delete
      name: '$((Resolve-Path .\lib\index.js).Path -replace '\\','/')'
"@ | Add-Content -Path $p
```

`anchorInsertedPluginNames` converts the absolute path to a `file://` URL at parse time (`dsh-app-boot/lib/index.js:1169-1178`). Row ids must stay unique — if Step 2 already put `dsh-session-delete` in `bundles`, do **not** also add this row with the same effective id. Pick one of Step 2 / Step 3.

**Step 4 — run and iterate.**

```powershell
# Option 1: CLI surface, gets live patch-file reload (patchReload: live is implemented here)
$env:DSH_HOME = "D:\Tools\dsh-session-delete\.devhome"
dsh --profile web

# Option 2: the Desktop app against the scratch home
#   the profile dir is $DSH_HOME\profiles\<name>; the scratch profile is a plain web template,
#   so Desktop's ensureDesktopProfile() would repair it — prefer Option 1 for fast iteration,
#   or use the real desktop profile (Step 5) and expect a restart.
```

- **Client half:** in a second terminal, `pnpm run dev` (`tsdown --watch`). `@deepseek-ai/dsh-client-hmr` stat-polls `lib/client.js` every 500 ms and pushes a `rebuilt` frame on `/plugins/events`; the browser swaps the module **without a reload** — as long as the row already exists in the boot graph.
- **Host half:** `lib/index.js` is ESM-imported once. A change needs a restart (the `hmr` row is `disabled: true` in `dsh-base/cordis.patch.yml:19-25` and the Desktop never installs the patch-file watcher).
- **Patch-layer changes** (`cordis.patch.yml`, `$DSH_HOME/cordis.patch.yml`): applied within ~1 s under the CLI; require a restart under the Desktop.

**Step 5 — promote to the real Desktop profile.** Append (or let `dsh plugin add` append) to `C:\Users\nan ge\.dsh\profiles\desktop\package.json`:

```jsonc
"dependencies": { "dsh-session-delete": "link:D:\\Tools\\dsh-session-delete" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-session-delete"],
                      "patchReload": "live" } }
```

`dsh-session-delete` **must remain last** in `bundles`: `desktopBundleList` preserves third-party order after the installation-owned prefix (`lib/profile-39RdjuE6.js:303-306`), and the Desktop's own patch is spliced in right after `@deepseek-ai/dsh-web-app` (`:711-713`). Then **restart DSH Desktop** — desktop activates the new bundle only at boot. Keep a Recovery checkpoint in mind: Desktop keeps three healthy-start configuration checkpoints (`dsh-community-market/src/install/service.ts:658-661`, `docs/install-and-uninstall.md:29`).

**Step 6 — verify it loaded.**

- `dsh --profile desktop --dump-config` (CLI, read-only) — the composed YAML must contain your row.
- In the app: Settings → Plugins, or the `pluginInventory/list` RPC whose host implementation enumerates the Loader's entries (`@deepseek-ai/dsh-host-plugin-inventory/lib/index.js:108-131`).
- Watch `profile/node_modules/dsh-session-delete` resolve, and the Desktop log for `client-modules:` diagnostics — a missing `lib/client.js` fails loudly with `client bundle not found; run \`pnpm run build\` before launch` plus the exact path (`dsh-client-modules/lib/index.js:90-105`).

**Step 7 — publish when ready.**

```powershell
# bump to an exact STABLE semver first — the market rejects prereleases
npm version 0.1.0 --no-git-tag-version
pnpm run build
npm pack --dry-run          # confirm package.json / cordis.patch.yml / lib/client.js are in the tarball
npm publish                 # publishConfig already points at registry.npmjs.org
```

Post-publish, to appear in the built-in Community Market the plugin also needs a **catalog provider** to list it (§4.4) — publishing alone does not register it. The display-only fallback command that will always work is:

```
dsh plugin add --save-exact dsh-session-delete@0.1.0
```

### 6.6 Checklist of hard requirements (do not omit any)

1. `exports["./client"]` exists **iff** `dsh.client` is declared — else `client-modules` throws at boot. **[V]**
2. `lib/client.js` calls `window.__ModuleLoader__.load({ id: "<exact package name>", factory })` exactly once, with a `sourceMappingURL` trailer. **[V]**
3. Every `require()` in the client bundle is either a tsdown `external` **and** backed by a graph row (via `dsh.client.inject`) or a platform seed word. **[V]**
4. `dsh.bundle.patch` is a safe relative path and the file exists in the tarball. **[V]**
5. `cordis.patch.yml` row ids are unique across the whole composed tree. **[V]**
6. Published `version` is an exact stable semver. **[V]**
7. Peer `@deepseek-ai/*` versions are consistent with the shipping Desktop (`0.1.5-rc.2`), and `dsh.client.inject` names refer to packages that actually exist in this release. **[V]**

---

## 7. Open questions / not verified

- **[U]** The literal contents of `@deepseek-ai/dsh-package-manifest/src/types.ts` (`DshManifest`). The package ships only an 11-byte `lib/index.js` in this install; the field set above is reconstructed from every consumer, which is authoritative for behaviour but may be a superset/subset of the published type.
- **[U]** Whether `file:` (as opposed to `link:`) materialises a **directory** spec as a symlink or a copy under pnpm 11.8.0 with `nodeLinker: hoisted`. The docs and the `anchorPathSpec` implementation support both spellings; `link:` is the safe choice for live editing.
- **[U]** Whether the **packaged/asar** Desktop runtime (`loader.internal !== undefined` in a non-Desktop build) changes the relative-vs-`file://` name resolution path in a way that affects Option B. The Desktop explicitly sets `hostCtx.loader.internal = void 0` (`lib/host-process-entry.js:56`), which is the branch the analysis above relies on.
- **[U]** Whether `README.i18n.yaml` hashes are enforced by any check in this tree. The upstream variant names a verifier (`pnpm run verify-translation-pairing`) that is not present in the installed artifacts.
- **[U]** Exact behaviour of `dsh --dump-config` on `0.1.5-rc.2` for a profile that mounts a `file:`-URL row (I read the dump implementation's entry point, `renderConfigDump` is exported from `dsh-app-boot`, but did not execute it).
- **[I]** That `dsh.client.inject` and the tsdown `external` list are meant to be kept in sync by hand. Both lists exist independently in every shipped plugin; no build-time check cross-validates them (the closest thing is `dsh-community-market/scripts/verify-client-loader.mjs`, which only inspects the *requested* specifier set after the fact).
