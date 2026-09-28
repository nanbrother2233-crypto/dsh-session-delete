/**
 * dsh-session-delete — browser half.
 *
 * The session manager lives in a right-pane tab, registered as a tab *type* so
 * it appears in the pane's own add-tab menu alongside the shipped Files tab.
 * That is the supported discovery path: the pane dispatches a tab body by
 * `entryKey = definition.id ?? tab.kind`, and a registered type is what puts an
 * entry in the menu.
 *
 * Only platform-seeded modules are imported (react, jsx-runtime, ui-primitives).
 * Everything else arrives through slot props or `ctx.get`, because a module
 * request outside the seed table throws at materialization.
 *
 * Note on the session header: the header's delete affordance was dropped. The
 * header describes the session the user is *looking at*, so a delete there would
 * always be refused by the current-session guard and would be a dead control.
 * The header instead opens the manager.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, IconRefreshOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import { nestRows } from '../nest.js'

/** Dictionary namespace owned by this plugin. */
const NS = 'session-delete'

/** Tab type identity; also the key its body and title register under. */
const TAB_ID = 'dsh-session-delete'

/** Tab kind passed to the pane's navigation. */
const TAB_KIND = 'session-delete'

/** Marker header the host requires on every mutating request (forces a preflight). */
const GUARD_HEADER = 'x-dsh-session-delete'

/** Base path of the host routes. */
const API = '/api/session-delete'

/** Simplified Chinese dictionary (the key-set source of truth). */
const zh = {
  'type.label': '会话管理',
  'guide.title': '会话管理',
  'guide.description': '跨工作区列出会话并彻底删除',
  'title': '会话管理',
  'refresh': '刷新',
  'search.placeholder': '搜索标题或工作区路径',
  'empty.none': '没有会话',
  'empty.filtered': '没有匹配的会话',
  'loading': '载入中…',
  'error.load': '载入会话失败',
  'group.ungrouped': '未分组',
  'badge.live': '运行中',
  'badge.subagent': '子代理',
  'badge.parent': '所属主任务：{name}',
  'badge.descendants': '含 {n} 个子会话',
  'select.all': '全选',
  'select.clear': '清除选择',
  'selected': '已选 {n} 项',
  'action.delete': '彻底删除',
  'confirm.title': '彻底删除会话？',
  'confirm.body': '将永久删除 {n} 个会话（含 {children} 个子代理会话）的日志、投影缓存与相关索引。此操作不可撤销。',
  'confirm.hint': '如果只是想把它从列表中隐藏，请改用内置的“归档会话”，归档可以保留数据。',
  'confirm.blocked': '以下会话无法删除，请先取消选择：',
  'confirm.cancel': '取消',
  'confirm.proceed': '永久删除',
  'blocker.live': '正在运行',
  'blocker.current': '当前打开的会话',
  'blocker.missing': '已不存在',
  'blocker.duplicate-on-disk': '磁盘上存在重复 id',
  'result.title': '删除完成',
  'result.ok': '已删除 {n} 个会话。',
  'result.failed': '{n} 个会话删除失败：',
  'close': '关闭',
  'home': '数据目录：{home}',
}

/** English dictionary, checked complete against the zh key set. */
const en = {
  'type.label': 'Sessions',
  'guide.title': 'Session manager',
  'guide.description': 'List sessions across workspaces and delete them for good',
  'title': 'Session manager',
  'refresh': 'Refresh',
  'search.placeholder': 'Filter by title or workspace path',
  'empty.none': 'No sessions',
  'empty.filtered': 'No matching sessions',
  'loading': 'Loading…',
  'error.load': 'Could not load sessions',
  'group.ungrouped': 'Ungrouped',
  'badge.live': 'Running',
  'badge.subagent': 'Subagent',
  'badge.parent': 'Owning task: {name}',
  'badge.descendants': '{n} child sessions',
  'select.all': 'Select all',
  'select.clear': 'Clear',
  'selected': '{n} selected',
  'action.delete': 'Delete permanently',
  'confirm.title': 'Delete sessions permanently?',
  'confirm.body': 'This permanently removes {n} session(s) — including {children} delegated child session(s) — along with their logs, projection cache and related indexes. It cannot be undone.',
  'confirm.hint': 'To merely hide a session from the list, use the built-in “Archive session” instead; archiving keeps the data.',
  'confirm.blocked': 'These sessions cannot be deleted; deselect them first:',
  'confirm.cancel': 'Cancel',
  'confirm.proceed': 'Delete permanently',
  'blocker.live': 'currently running',
  'blocker.current': 'currently open',
  'blocker.missing': 'no longer exists',
  'blocker.duplicate-on-disk': 'duplicate id on disk',
  'result.title': 'Delete finished',
  'result.ok': 'Deleted {n} session(s).',
  'result.failed': '{n} session(s) failed:',
  'close': 'Close',
  'home': 'Data directory: {home}',
}

/** One row from `GET /api/session-delete/sessions`. */
interface SessionSummary {
  readonly id: string
  readonly title?: string
  /**
   * The name to draw, derived by the host with the same chain the built-in
   * session list uses (title → workspace basename → id), so a row here reads
   * exactly like the sidebar row for the same session. Optional only so an
   * older host half degrades to the raw title instead of a blank row.
   */
  readonly displayName?: string
  readonly cwd?: string
  readonly createdAt?: string
  readonly live: boolean
  readonly persisted: boolean
  readonly parentSession?: string
  /**
   * How the parent reads, for a delegated child. The manager is the only
   * surface that lists child sessions at all, so a child with no parent name is
   * an anonymous row in a delete list.
   */
  readonly parentName?: string
  readonly delegated: boolean
  readonly descendantCount: number
}

/** A refusal reported by the host. */
interface DeleteBlocker {
  readonly id: string
  readonly reason: 'live' | 'missing' | 'duplicate-on-disk' | 'current'
}

/** A reviewed delete. */
interface DeletePlan {
  readonly targets: readonly string[]
  readonly expanded: readonly string[]
  readonly blockers: readonly DeleteBlocker[]
}

/** Per-session outcome. */
interface DeleteOutcome {
  readonly id: string
  readonly removed: boolean
  readonly error?: string
}

/** What `GET /sessions` returns. */
interface SessionsResponse {
  readonly home: string
  readonly sessions: readonly SessionSummary[]
}

/** Thrown for any non-2xx response, carrying the server's message. */
class ApiError extends Error {}

/** Call one host route, always sending the guard header on mutations. */
async function call<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  const response =
    init === undefined
      ? await fetch(`${API}${path}`, { cache: 'no-store' })
      : await fetch(`${API}${path}`, {
          method: init.method,
          cache: 'no-store',
          headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
          body: JSON.stringify(init.body),
        })
  const text = await response.text()
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `request failed: ${String(response.status)}`
    throw new ApiError(message)
  }
  return parsed as T
}

/** Relative time for a session's `createdAt`, falling back to the raw value. */
function relativeTime(value: string | undefined): string {
  if (value === undefined) return ''
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  const seconds = Math.round((Date.now() - parsed) / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)}h`
  return `${String(Math.round(hours / 24))}d`
}

/** Props the pane composes into a tab body; only the translator is required. */
interface TabProps {
  readonly t?: (key: string, params?: Record<string, string | number>) => string
  readonly tSessionDelete?: (key: string, params?: Record<string, string | number>) => string
  /**
   * The session whose right pane holds this tab, injected by the session-scoped
   * seat. Sent to the host so it can refuse to delete the session the user is
   * looking at — the host has no other way to know which one that is.
   */
  readonly sessionId?: string
  /** Injected by this plugin's own registration face. */
  readonly refreshSessions?: () => Promise<void>
}

/**
 * The session manager body.
 *
 * @param props - composed slot props; the namespace translator arrives either as
 * `tSessionDelete` (this registration's own namespace) or as a shared `t`.
 */
export function SessionManagerBody(props: TabProps): React.ReactElement {
  const translate = props.tSessionDelete ?? props.t ?? ((key: string) => key)
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'error'; home: string; sessions: readonly SessionSummary[]; error?: string }>(
    { phase: 'loading', home: '', sessions: [] },
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [plan, setPlan] = useState<DeletePlan | undefined>(undefined)
  const [outcomes, setOutcomes] = useState<readonly DeleteOutcome[] | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, phase: 'loading' }))
    try {
      const body = await call<SessionsResponse>('/sessions')
      setState({ phase: 'ready', home: body.home, sessions: body.sessions })
    } catch (error) {
      setState({ phase: 'error', home: '', sessions: [], error: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Rows after the text filter, newest-first as the host returned them. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return state.sessions
    return state.sessions.filter((session) => {
      // `parentName` is in the haystack so "everything under X" is one query.
      const haystack = `${session.displayName ?? session.title ?? ''} ${session.parentName ?? ''} ${
        session.cwd ?? ''
      } ${session.id}`.toLowerCase()
      return haystack.includes(needle)
    })
  }, [state.sessions, query])

  /**
   * Rows grouped by workspace path, each group nested parent-first.
   *
   * The workspace still owns the outer grouping — that is what the host's
   * ordering and the folder headings describe — and lineage owns the order
   * inside it. A child whose parent is filtered away, or that lives in another
   * working directory, simply floats back to the top level of its own group and
   * falls back to naming its parent.
   */
  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>()
    for (const session of visible) {
      const key = session.cwd ?? ''
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [session])
      else bucket.push(session)
    }
    return [...map.entries()].map(([cwd, rows]) => [cwd, nestRows(rows)] as const)
  }, [visible])

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const requestDelete = useCallback(async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const preview = await call<DeletePlan>('/preview', {
        method: 'POST',
        body: { ids: [...selected], currentSessionId: props.sessionId },
      })
      setPlan(preview)
    } catch (error) {
      setOutcomes([{ id: '*', removed: false, error: error instanceof Error ? error.message : String(error) }])
    } finally {
      setBusy(false)
    }
  }, [selected, props.sessionId])

  const confirmDelete = useCallback(async () => {
    if (plan === undefined) return
    setBusy(true)
    try {
      const result = await call<{ outcomes: readonly DeleteOutcome[] }>('/delete', {
        method: 'POST',
        body: { ids: [...selected], currentSessionId: props.sessionId, confirm: true },
      })
      setOutcomes(result.outcomes)
      setPlan(undefined)
      setSelected(new Set())
      await load()
      // Ask the session store to re-read the host baseline so the sidebar and
      // any open conversation drop the deleted rows without a page reload.
      await props.refreshSessions?.()
    } catch (error) {
      setOutcomes([{ id: '*', removed: false, error: error instanceof Error ? error.message : String(error) }])
      setPlan(undefined)
    } finally {
      setBusy(false)
    }
  }, [plan, selected, load, props.refreshSessions, props.sessionId])

  const failures = (outcomes ?? []).filter((outcome) => !outcome.removed)
  const removed = (outcomes ?? []).filter((outcome) => outcome.removed).length
  const children = plan === undefined ? 0 : plan.expanded.length

  /**
   * The readable handle for one row.
   *
   * The host already projected it with the built-in list's own chain — the
   * log's durable title, else the workspace basename, else the id — because the
   * two surfaces list the same corpus and a session must not have two names.
   * The fallbacks here only cover a host half that predates `displayName`.
   */
  const label = (session: SessionSummary): string => session.displayName ?? session.title ?? session.id

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '8px 10px', flex: 'none' }}>
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          placeholder={translate('search.placeholder')}
          aria-label={translate('search.placeholder')}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button
          onClick={() => {
            void load()
          }}
          disabled={busy}
          aria-label={translate('refresh')}
        >
          <IconRefreshOutline16 />
        </Button>
      </div>

      <div style={{ padding: '0 10px 6px', display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
        <button
          type="button"
          onClick={() => {
            setSelected(new Set(visible.map((session) => session.id)))
          }}
        >
          {translate('select.all')}
        </button>
        <button
          type="button"
          onClick={() => {
            setSelected(new Set())
          }}
        >
          {translate('select.clear')}
        </button>
        <span>{translate('selected', { n: selected.size })}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 10px' }}>
        {state.phase === 'loading' && <p>{translate('loading')}</p>}
        {state.phase === 'error' && (
          <p role="alert">
            {translate('error.load')}: {state.error ?? ''}
          </p>
        )}
        {state.phase === 'ready' && visible.length === 0 && (
          <p>{translate(state.sessions.length === 0 ? 'empty.none' : 'empty.filtered')}</p>
        )}
        {groups.map(([cwd, rows]) => (
          <section key={cwd === '' ? '__ungrouped__' : cwd}>
            <h4 style={{ margin: '8px 0 4px', wordBreak: 'break-all' }}>
              {cwd === '' ? translate('group.ungrouped') : cwd}
            </h4>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {rows.map(({ row: session, depth }) => (
                <li
                  key={session.id}
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'baseline',
                    padding: '2px 0',
                    // Indentation is the whole point: a child sits under the
                    // session whose delete would take it along.
                    paddingLeft: depth * 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(session.id)}
                    onChange={() => {
                      toggle(session.id)
                    }}
                    aria-label={label(session)}
                  />
                  <span
                    // The full id, always: a title is the readable handle, but the
                    // id is what a delete outcome and the host report by name.
                    title={`${session.id}`}
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {label(session)}
                  </span>
                  {session.live && <span title={translate('badge.live')}>●</span>}
                  {/*
                    Every child carries the mark and names its parent, whether it
                    is nested or not. The indentation shows *where* the child
                    sits, but position alone is not an identifier: a parent can
                    be scrolled out of view, or filtered away by the search box,
                    leaving an indented row whose owner is off-screen. So `↳ name`
                    makes the row self-describing either way, and the tooltip
                    spells the relationship out in words — a bare parent id there
                    told the reader nothing they could act on.
                  */}
                  {session.parentName !== undefined ? (
                    <span
                      title={translate('badge.parent', { name: session.parentName })}
                      style={{
                        flex: 'none',
                        maxWidth: '45%',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        opacity: 0.7,
                      }}
                    >
                      ↳ {session.parentName}
                    </span>
                  ) : (
                    session.delegated && <span title={translate('badge.subagent')}>↳</span>
                  )}
                  {session.descendantCount > 0 && (
                    <span title={translate('badge.descendants', { n: session.descendantCount })}>
                      +{session.descendantCount}
                    </span>
                  )}
                  <span>{relativeTime(session.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div style={{ flex: 'none', padding: 10, display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid rgba(128,128,128,.25)' }}>
        <Button
          onClick={() => {
            void requestDelete()
          }}
          disabled={busy || selected.size === 0}
        >
          <IconTrashOutline16 /> {translate('action.delete')}
        </Button>
        <span style={{ opacity: 0.7 }}>{translate('home', { home: state.home })}</span>
      </div>

      <Modal
        open={plan !== undefined}
        onClose={() => {
          setPlan(undefined)
        }}
        title={translate('confirm.title')}
        closeLabel={translate('confirm.cancel')}
        footer={
          <>
            <Button
              onClick={() => {
                setPlan(undefined)
              }}
              disabled={busy}
            >
              {translate('confirm.cancel')}
            </Button>
            <Button
              onClick={() => {
                void confirmDelete()
              }}
              disabled={busy || plan === undefined || plan.blockers.length > 0}
            >
              {translate('confirm.proceed')}
            </Button>
          </>
        }
      >
        <p>{translate('confirm.body', { n: plan?.targets.length ?? 0, children })}</p>
        <p style={{ opacity: 0.75 }}>{translate('confirm.hint')}</p>
        {(plan?.blockers.length ?? 0) > 0 && (
          <>
            <p role="alert">{translate('confirm.blocked')}</p>
            <ul>
              {(plan?.blockers ?? []).map((blocker) => (
                <li key={blocker.id}>
                  {blocker.id} — {translate(`blocker.${blocker.reason}`)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>

      <Modal
        open={outcomes !== undefined}
        onClose={() => {
          setOutcomes(undefined)
        }}
        title={translate('result.title')}
        closeLabel={translate('close')}
        footer={
          <Button
            onClick={() => {
              setOutcomes(undefined)
            }}
          >
            {translate('close')}
          </Button>
        }
      >
        <p>{translate('result.ok', { n: removed })}</p>
        {failures.length > 0 && (
          <>
            <p role="alert">{translate('result.failed', { n: failures.length })}</p>
            <ul>
              {failures.map((outcome) => (
                <li key={outcome.id}>
                  {outcome.id}: {outcome.error ?? ''}
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </div>
  )
}

/** The tab chip title. */
export function SessionManagerTitle(props: TabProps): React.ReactElement {
  const translate = props.tSessionDelete ?? props.t ?? ((key: string) => key)
  return <span>{translate('type.label')}</span>
}

/** Browser services this plugin requires. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/** The `sidebarRightTabs` registry, as far as this plugin uses it. */
interface TabRegistryLike {
  register(definition: {
    id: string
    kind: string
    priority: string
    title: () => string
    guide: readonly { order: number; title: () => string; description: () => string }[]
  }): () => void
}

/** The client context slice this plugin touches. */
interface ClientContext {
  get(serviceName: string): unknown
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  }
  readonly sidebarRightTabs: TabRegistryLike
  readonly slots: {
    inject(slot: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(callback: () => () => void, label?: string): void
}

/**
 * Register the dictionaries, the tab type, and its body and title seats.
 *
 * @param context - the client root context.
 */
export function apply(context: unknown): void {
  const ctx = context as ClientContext
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-delete: dictionaries')

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'builtin',
        title: () => t('type.label'),
        guide: [
          {
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
          },
        ],
      }),
    'dsh-session-delete: tab type',
  )

  /**
   * Ask the browser's session store to re-read the host baseline.
   *
   * Resolved lazily rather than through `inject`, because the controller that
   * provides `sessions` mounts independently of this plugin; a profile without
   * it simply refreshes one surface less.
   */
  const refreshSessions = async (): Promise<void> => {
    const sessions = ctx.get('sessions') as { refresh?: () => Promise<void> } | undefined
    if (typeof sessions?.refresh === 'function') await sessions.refresh()
  }

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            inject: () => ({ refreshSessions }),
          },
          SessionManagerBody,
        ),
      ),
    'dsh-session-delete: tab body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID,
            locale: NS,
          },
          SessionManagerTitle,
        ),
      ),
    'dsh-session-delete: tab title',
  )
}
