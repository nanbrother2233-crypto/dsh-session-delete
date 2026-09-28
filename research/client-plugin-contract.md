# DSH 插件契约（已从源码验证）

环境：DSH Desktop `2.0.13` / `@deepseek-ai/dsh 0.1.5-rc.2`（`@deepseek-ai/dsh-client-modules` 内部标识
`0.1.5-rc.2-fb2c4b9`）。
所有结论均来自下列路径的源码，非推测。

---

## 1. 客户端插件清单（`package.json` 的 `dsh.client`）

权威解析代码：`@deepseek-ai/dsh-client-modules/lib/index.js:139-166`（`parseDshClient` / `clientExportOf`）。

```ts
// dsh-client-modules/lib/index.js:140-154
function parseDshClient(pkgName, value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null) throw ...
  const decl = value;
  if (typeof decl.platform !== "string") throw ...   // 必填
  const inject   = optionalStringArray(pkgName, "dsh.client.inject",   decl.inject);
  const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
  if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw ...
  return { platform, ...inject, ...external, ...immediately };
}
```

字段语义：

| 字段 | 必填 | 含义 |
|---|---|---|
| `platform` | ✅ `string`（web 组合用 `'web'`） | 目标载体 |
| `inject` | ❌ `string[]` | 必须先加载的**动态插件包**（本插件的 external 依赖提供方） |
| `external` | ❌ `string[]` | 基座（`PLATFORM_MODULES`）之外的精确模块请求，每个必须被某个动态 row 或静态表键应答 |
| `immediately` | ❌ `boolean` | 是否立即加载 |

`exports["./client"]` 必须解析为字符串，或 `{ default: string }`
（`client-modules/lib/index.js:156-166`）——指向**已构建**的 bundle。

再补一条硬约束（`README.zh.md:46`）：

> 宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；
> 缺失 bundle 会以一条构建说明加包／路径列表的方式让激活大声失败。

**结论：客户端半侧必须是构建产物，源码不能直接在运行时消费。**

---

## 2. 客户端 bundle 的包装格式

`tsdown.config.ts`（`dsh-community-market/tsdown.config.ts:5-37`）是官方外部插件参考实现：

```ts
export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
             '@deepseek-ai/cordis',
             '@deepseek-ai/dsh-client-locale/client',
             '@deepseek-ai/dsh-client-store',
             '@deepseek-ai/dsh-client-ui-layout/client',
             '@deepseek-ai/dsh-client-ui-primitives',
             '@deepseek-ai/dsh-client-ui-settings/client',
             '@deepseek-ai/dsh-client-ui-sidebar/client',
             '@deepseek-ai/dsh-client-ui-slots'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
```

产出文件的真实开头（`dsh-client-ui-sidebar/lib/client.js:1-5`）：

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		...
```

要点：
- 包装是 **CJS-factory 形态**（不是 ESM），宿主用同步 `require` 解析 external。
- `banner` 里的 `id` 用的是**包名**（`dsh-community-market`），不是 `包名/client`；宿主按解析出的 manifest 包名
  作为浏览器模块身份（`dsh-client-modules/README.zh.md:68`）。
- 产物路径 `/plugins/<id>/client.js`（`client-modules/lib/index.js:183`）。
- 宿主发布前会剥离 `//# sourceMappingURL=` 尾部（`index.js:128`），所以 `sourcemap: true` 是安全且被期待的。
- 构建工具为 `tsdown`（`dsh-community-market` devDep `tsdown: 0.22.2`）。`format: 'cjs'` + `intro/banner/footer`
  是产出该包装的唯一原因。

---

## 3. 模块解析与共享基座

`dsh-client-modules/README.zh.md:40-42`：

- 外壳播种一张冻结模块表 `PLATFORM_MODULES`（React、Cordis 与静态 UI 库）；每个动态 bundle 精确针对该基座解析其
  external。
- `dsh.client.external` 只添加基座之外的精确请求，每个由它命名的动态包 row 或精确静态表键回答。
- 纯类型 import 会被擦除，不产生请求。
- 组合阶段会拒绝：畸形请求、缺失提供方、自请求、同步请求环
  （`client-modules/lib/index.js:362`：row 不得在自己的 `dsh.client.external` 里声明自己的包名）。

---

## 4. 宿主↔客户端桥接

**机制：宿主 HTTP 路由 + 浏览器 `fetch`。** 不是 RPC/typert。

宿主注册（`dsh-community-market/src/host/routes.ts:718` 等）：

```ts
ctx.webServer.register({ kind: 'exact', path: ROUTE_STATE, handler: async (req, res) => { ... } })
```

客户端调用（`dsh-community-market/src/client/api.ts:42-47`）：

```ts
await fetch('/api/community-market/state', { cache: 'no-store', signal })
```

`dsh-host-webserver` 服务契约（`README.zh.md:12,28-55`）：

- `register(route)` 添加具名 `exact` / `prefix` HTTP route，返回 disposer；**同一张表内重复路径会抛错**。
- `registerUpgrade(route)` 精确 pathname 的 upgrade route。
- `registerFallback(handler)` 唯一席位，第二次注册抛错（web 组合里由 SPA dist 服务器占有，**不要碰**）。
- 匹配顺序：精确 route → 最长前缀 → 回退 handler。
- `ctx.webServer.port` / `.host` 暴露组合期事实。
- **Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch** —— 所以 `fetch('/api/...')` 在桌面端同样可用。
- handler 抛错 → 该请求 400（响应头已发出则销毁 socket）并记 warning，绝不退出进程。

---

## 5. 宿主插件模块形状

`dsh-community-market/src/index.ts:17-45`：

```ts
export const name = 'community-market'
export const inject = ['webServer', 'settings']
export function apply(ctx: Context): void {
  ctx.effect(() => registerMarketRoutes(...), 'community-market: routes')
  ctx.inject(['desktopActions'], (desktopCtx) => { ... })   // 可选能力
}
```

可选能力用 `ctx.inject([...], (ctx) => ...)` + `ctx.effect(..., label)` 挂载并在 disposer 里清理；
`ctx.inject` 里的服务不可用时该回调不运行。

---

## 6. 插槽（slots）扩展点

`@deepseek-ai/dsh-client-ui-slots`。注册形态（`dsh-client-ui-sidebar/lib/client.js:375-405`）：

```js
ctx.slots.inject("sidebar", () => ctx.slots.register({
  name: "sidebar",
  locale: NS,
  children: {
    "sidebar.brand.mark":  { kind: "single", scope: "root" },
    "sidebar.panellist":   { kind: "list",   scope: "root" },
    "sidebar.workspaces":  { kind: "single", scope: "root" },
    "sidebar.settings":    { kind: "single", scope: "root" },
    "sidebar.footer.action": { kind: "list", scope: "root" },
  },
  inject: injectProps,
}, SidebarRoot))
```

`kind: "single"` = 单占用（第二个注册者挤不进去）；`kind: "list"` = 多占用。

### 侧边栏会话树不在 `ui-sidebar` 里

`ui-sidebar` 只是外壳：logo、新建会话、全局面板列表、`sidebar.workspaces` 区域、底部
（`dsh-client-ui-sidebar/lib/client.js:189-303`）。它把工作区/会话浏览区域整体交给
`sidebar.workspaces` 槽位的注册者（见其文档注释 `:82-85`）。

那个注册者是 `@deepseek-ai/dsh-client-ui-workspace`：

```js
// dsh-client-ui-workspace/lib/client.js:2794-2800
ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
  name: "sidebar.workspaces",
  children: { "sidebar.workspaces.directoryFlow": { kind: "single", ... } },
}, ...))
```

它**只**开放了 `sidebar.workspaces.directoryFlow` 这一个子槽位。

### 会话行菜单是硬编码的 —— 无法注入

`dsh-client-ui-workspace/lib/client.js:948-964`：

```js
const sessionMenuItems = [
  { id: "rename",  label: t("rename"),              icon: IconEditOutline16 },
  { id: "fork",    label: t("menu.fork"),           icon: IconBranchOutline16 },
  { id: "archive", label: t("menu.archiveSession"), icon: IconArchiveOutline20 },
];
```

`onSelect`（`:1014-1019`）同样是硬编码分支。整张官方插槽清单（`dsh-cordis-client-runner/lib/client.js:2233-4600`
的示例目录）中**没有任何 session-row action 类插槽**。

**结论：第三方插件无法在内置会话行里添加"删除"菜单项。** 要做到只有两条重代价路径：
禁用 `ui-workspace` 的浏览区并自己重写整棵树；或魔改 `node_modules` 里的内置包（就不算插件了）。

### 本插件采用的、确实可用的插槽

| 插槽 | kind | 已在用者 |
|---|---|---|
| `conversation.session.header.actions` | list | ui-jobs、ui-schedule、ui-open-in-app |
| `sidebar.right.pane.tab` | key | ui-sidebar-right、ui-sidebar-files |
| `sidebar.right.pane.tab.title` | key | ui-sidebar-right、ui-sidebar-files |
| `sidebar.footer.action` | list | ui-cordis |
| `settings.section` | list | ui-settings-general、ui-settings-models、ui-settings-plugins |
| `shell.overlay` | list | （有文档，未发现实际使用者） |

---

## 7. Profile 补丁层：本地未发布插件的加载方式

权威实现：`@deepseek-ai/dsh-app-boot/lib/index.js`。

### 补丁项语义（`dsh-app-boot/lib/index.js:59-105`）

```js
function applyEntryPatches(data, patches, warn) {
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) { /* 找 id，必须是 group，target.config.push(...insert) */ }
      else data.push(...insert);          // 顶层追加
    } else {
      // id 必填；找 id；可选用 name 做断言校验；应用 overrides（如 disabled、config）
    }
  }
}
```

即三种写法：

```yaml
# 1) 顶层插入新插件
- insert:
    - id: session-delete
      name: 'dsh-session-delete'
# 2) 覆盖/禁用既有条目
- id: ui-schedule
  disabled: true
# 3) 往 group 条目里插子条目
- id: some-group
  insert: [ ... ]
```

### 相对路径 / 文件 URL 支持

`dsh-app-boot/lib/index.js:1169-1177`：

```js
/** Convert inserted filesystem paths to file URLs, anchoring relative paths beside the patch */
function anchorInsertedPluginNames(patches, file) {
  ... for (const patch of patches) patch.insert?.forEach(visit);
}
```

→ `insert` 里的 `name` 可以是相对补丁文件的路径或文件 URL，**因此无需 pnpm 安装即可加载本地插件**。

### 热重载

- 组合顺序：空列表起，依次应用各 bundle 的补丁层（按 `dsh.profile.bundles` 顺序）→ profile 自己的
  `cordis.patch.yml` → 启动器层（`--patch` 文件与 flag 派生补丁）（`:296-299`）。
- `patchReload` 只能是 `"live"` 或 `"startup"`（`:847`）；自定义 profile 默认 `live`，desktop profile 显式声明 `live`
  （`C:\Users\nan ge\.dsh\profiles\desktop\package.json:10`）。
- live 模式通过 Cordis HMR **事务性重放**用户补丁层（`:1103-1120`）——改 `cordis.patch.yml` 可热生效。
- 补丁匹配不到任何行时只是 warning 并被跳过；但补丁文件本身解析失败是**致命错误**（`:1180-1199`）。

---

## 8. 本机环境事实

| 项 | 值 |
|---|---|
| `dsh` CLI | `C:\Users\nan ge\AppData\Roaming\DSH Desktop\host-commands\desktop\generations\...\bin\dsh.cmd` |
| ⚠️ 该 shim | **硬编码 `set "DSH_HOME=C:\Users\nan ge\.dsh"`**，会覆盖外部 `DSH_HOME` |
| 绕过方式 | 直接 `& "D:\Tools\DSH\DSH Desktop\DSH Desktop.exe" --expose-internals "D:\...\app\lib\desktop-cli.js" ...`（需 `ELECTRON_RUN_AS_NODE=1`） |
| 隔离 home 验证 | 已实测可行：`DSH_HOME=<ws>\.devhome` + `--profile web --dump-config` 正确组合出完整插件树 |
| `dsh --patch <path>` | profile 层之上的额外补丁叠加层，可重复 |
| `dsh plugin --profile <name> add <pkg>` | 官方装插件入口（转发给 profile 目录里的 pnpm） |
| npm 网络 | `registry.npmjs.org` 可达；但缓存目录必须在工作区内，否则 `EPERM` |
| npm 缓存重定向 | `npm install --cache <ws>\.scratch\npm-cache`（实测成功） |
| 沙箱 | workspace-write；写 `C:\Users\nan ge\.dsh` 会被拒（真实 profile 装载需提权或用户执行） |
| 工具链 | node v22.19.0、npm 10.9.3、pnpm 11.8.0、git 2.51.0（工作区已 `git init`） |
| git 身份 | `shenhaonan` / `2968942779@qq.com` |
