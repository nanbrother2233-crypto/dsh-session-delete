# 客户端半侧：实现要点与待确认项

宿主半侧已完成并通过类型检查与测试。本文件记录**客户端半侧**（`src/client/index.tsx`）的
已验证契约与仍需确认的点，供下一轮直接开工。

---

## 1. 已确定：两个入口的注册形状

### 1.1 会话头部删除按钮 —— `conversation.session.header.actions`

`dsh-client-ui-jobs/lib/client.js:266-271`（同槽位现有使用者）：

```js
ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
  name: "conversation.session.header.actions",
  id: "job-list",        // 槽位内唯一 id
  order: 20,             // 排序
  locale: "job",         // 该条目的 i18n 命名空间
}, JobListAction))
```

- `kind: "list"` → 多插件可共存。
- 组件签名：`function JobListAction(props)`，props 由槽位主人（`ui-conversation`）组合注入。
- **未知**：props 的确切字段。需要读 `dsh-client-ui-jobs/lib/client.js` 里 `JobListAction`
  的实现，以及 `dsh-client-ui-conversation` 中该槽位的 `renderSlot` 调用传入的 owner 对象。
  目标是从 props 拿到**当前会话 id**（计划用 `session.id` / `sessionId`，需核实）。

### 1.2 右侧面板标签页 —— `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`

`dsh-client-ui-sidebar-files/lib/client.js:701-711`：

```js
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
  name: "sidebar.right.pane.tab",
  key: FILES_ID,          // key 而非 id —— 该槽位按 key 派发
  locale: NS,
  store,                  // createSnapshotStore(...) 建的快照 store
  inject,                 // "face"：暴露给面板的回调集合
}, FilesBody)), "ui-sidebar-files: files tab body")

ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
  name: "sidebar.right.pane.tab.title",
  key: FILES_ID,          // 与 body 同一 key
}, FilesTitle)), "ui-sidebar-files: files tab title")
```

- **未知**：`store` 与 `inject`（face）的契约 —— body 组件通过 props 收到什么、标题组件收到什么、
  标签页如何被打开（是否需要额外的触发按钮槽位）。需读 `dsh-client-ui-sidebar-right/lib/client.js`
  中对 `sidebar.right.pane.tab` 的 `entriesOfSlot` / `renderSlot` 消费点
  （已知它自身在 `:3705-3760` 附近注册了 `rightbar`、`sidebar.right.pane.tab.title` 等）。
- `createSnapshotStore` 来自 `@deepseek-ai/dsh-client-store`（**基座模块**，可直接 require）。

---

## 2. 已确定的可用能力

| 能力 | 用法 | 来源 |
|---|---|---|
| 会话列表 / 刷新 | `ctx.get("sessions").refresh()` | `dsh-api-session-controller/lib/client.js:3141` |
| 会话列表快照 | `ctx.get("sessions")` 提供的 store | 同上，`:3087` `reflect.provide("sessions", …)` |
| i18n | `ctx.effect(() => ctx.locale.register(NS, { zh, en }), label)` | `ui-jobs:262`、`ui-sidebar-files:695` |
| 插槽 | `ctx.slots.inject(slot, () => ctx.slots.register(options, Component))` | 全库一致 |
| 快照 store | `createSnapshotStore(initial)` | `@deepseek-ai/dsh-client-store` |
| UI 组件 | `@deepseek-ai/dsh-client-ui-primitives`：`Button`、`Tooltip`、`HoverCard`、`Menu`、`StateDot`、大量 `Icon*` | 基座模块 |

**基座模块（无需声明，可直接 require）**：`react`、`react/jsx-runtime`、`react-dom`、
`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
`@deepseek-ai/dsh-client-ui-dockkit`。

其余一律不可 require（会抛 `require("…") missed the module table`）——所以本插件**只**用基座模块，
通过 slot props 与 `ctx.get(...)` 与其它插件交互。**因此不需要 `dsh.client.external`。**

## 3. 待确认

1. `conversation.session.header.actions` 的 props 字段（当前会话 id 从哪来）。
2. `sidebar.right.pane.tab` 的 `store` / `inject` / body props / 打开方式。
3. 确认对话框用什么原语：`dsh-client-ui-primitives` 是否导出 `Modal` / `Dialog`
   （`ui-workspace` 的删除工作区确认弹窗用了 `Modal`，见其 `client.js:2432-2554`，
   含 `footer: (cancel, 确认按钮)`、`deleting`、`deleteError` 的写法可照抄）。
4. 删除确认弹窗需要提示"可改用内置归档"（用户要求）——文案进 zh/en 词典。

## 4. 客户端与宿主的接口（已完成，可直接调用）

宿主路由已实现（`src/routes.ts`）：

```
GET  /api/session-delete/sessions
     → { home: "~/.dsh" | "$DSH_HOME", sessions: SessionSummary[] }

POST /api/session-delete/preview
     headers: content-type: application/json, x-dsh-session-delete: 1
     body: { ids: string[], currentSessionId?: string }
     → DeletePlan { targets, expanded, blockers: {id, reason}[] }

POST /api/session-delete/delete
     headers: 同上
     body: { ids: string[], currentSessionId?: string, confirm: true }
     → 200 { plan, outcomes } | 409 { plan, outcomes: [] }（有 blocker）
```

`SessionSummary = { id, title?, cwd?, createdAt?, live, persisted, parentSession?, delegated, descendantCount }`
`blocker.reason ∈ 'live' | 'missing' | 'duplicate-on-disk' | 'current'`

客户端必须：
- 每次请求带上 `x-dsh-session-delete: 1`（这是防跨站触发的守卫头，缺了会 400）；
- 删除前先 `preview` 展示将要删除的条数与子会话数，再 `delete` 且带 `confirm: true`；
- 传入 `currentSessionId` 以便宿主拒绝删除当前会话（宿主无法自行得知浏览器在看哪个会话）。
