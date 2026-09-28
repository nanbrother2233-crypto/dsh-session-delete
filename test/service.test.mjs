import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectSubtree, displayNameOf, indexSessions, planDelete, subagentLabelFrom, summarizeHostSessions, titlesFromSnapshots } from '../lib/service.js'

/** Build a session-query shaped record. */
function record(id, options = {}) {
  return {
    header: {
      id,
      createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    live: options.live ?? false,
    persisted: options.persisted ?? true,
  }
}

/** A parent with two children, one of which has a child of its own. */
function family() {
  return [
    record('root', { createdAt: '2026-03-01T00:00:00.000Z' }),
    record('child-a', { parentSession: 'root', origin: 'subagent', createdAt: '2026-03-02T00:00:00.000Z' }),
    record('child-b', { parentSession: 'root', origin: 'subagent', createdAt: '2026-03-03T00:00:00.000Z' }),
    record('grandchild', { parentSession: 'child-a', origin: 'subagent', createdAt: '2026-03-04T00:00:00.000Z' }),
    record('unrelated', { createdAt: '2026-02-01T00:00:00.000Z' }),
  ]
}

test('indexSessions orders newest-first and counts transitive descendants', () => {
  const { summaries, byId } = indexSessions(family(), [])
  assert.deepEqual(
    summaries.map((summary) => summary.id),
    ['grandchild', 'child-b', 'child-a', 'root', 'unrelated'],
  )
  assert.equal(byId.get('root').descendantCount, 3)
  assert.equal(byId.get('child-a').descendantCount, 1)
  assert.equal(byId.get('child-b').descendantCount, 0)
  assert.equal(byId.get('unrelated').descendantCount, 0)
})

test('indexSessions normalizes an epoch-millisecond createdAt and orders by it', () => {
  // Decoded from a real log header: `"createdAt":1790238079236` — a number, not ISO text.
  const { summaries } = indexSessions(
    [record('older', { createdAt: 1790238079236 }), record('newer', { createdAt: 1790238080000 })],
    [],
  )
  assert.deepEqual(
    summaries.map((summary) => summary.id),
    ['newer', 'older'],
  )
  assert.equal(summaries[1].createdAt, new Date(1790238079236).toISOString())
})

test('indexSessions orders mixed ISO and epoch createdAt correctly', () => {
  const { summaries } = indexSessions(
    [record('iso', { createdAt: '2026-03-01T00:00:00.000Z' }), record('epoch', { createdAt: Date.parse('2026-04-01T00:00:00.000Z') })],
    [],
  )
  assert.deepEqual(
    summaries.map((summary) => summary.id),
    ['epoch', 'iso'],
  )
})

test('indexSessions marks delegated children by origin', () => {
  const { byId } = indexSessions(family(), [])
  assert.equal(byId.get('child-a').delegated, true)
  assert.equal(byId.get('root').delegated, false)
})

test('indexSessions tolerates a self-parenting header without looping', () => {
  const { byId } = indexSessions([record('self', { parentSession: 'self' })], [])
  assert.equal(byId.get('self').descendantCount, 0)
})

test('collectSubtree emits children before their parent', () => {
  const { childrenOf } = indexSessions(family(), [])
  const ordered = collectSubtree(['root'], childrenOf)
  assert.deepEqual([...ordered].sort(), ['child-a', 'child-b', 'grandchild', 'root'])
  assert.equal(ordered.at(-1), 'root', 'parent must be last')
  assert.ok(ordered.indexOf('grandchild') < ordered.indexOf('child-a'), 'grandchild precedes its parent')
})

test('collectSubtree deduplicates overlapping selections', () => {
  const { childrenOf } = indexSessions(family(), [])
  const ordered = collectSubtree(['root', 'child-a', 'child-a'], childrenOf)
  assert.equal(new Set(ordered).size, ordered.length)
})

test('collectSubtree tolerates a parent cycle', () => {
  const records = [record('a', { parentSession: 'b' }), record('b', { parentSession: 'a' })]
  const { childrenOf } = indexSessions(records, [])
  const ordered = collectSubtree(['a'], childrenOf)
  assert.deepEqual([...ordered].sort(), ['a', 'b'])
})

test('planDelete expands the selection to the whole subtree', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['root'], byId, childrenOf, { isLive: () => false, isPending: () => false })
  assert.deepEqual(plan.blockers, [])
  assert.equal(plan.targets.length, 4)
  assert.deepEqual([...plan.expanded].sort(), ['child-a', 'child-b', 'grandchild'])
})

test('planDelete refuses the session the caller is currently viewing', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['child-b'], byId, childrenOf, {
    isLive: () => false,
    isPending: () => false,
    currentSessionId: 'child-b',
  })
  assert.deepEqual(plan.blockers, [{ id: 'child-b', reason: 'current' }])
  assert.deepEqual(plan.targets, [], 'a blocked plan removes nothing')
})

test('planDelete refuses a live session', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['child-b'], byId, childrenOf, {
    isLive: (id) => id === 'child-b',
    isPending: () => false,
  })
  assert.deepEqual(plan.blockers, [{ id: 'child-b', reason: 'live' }])
  assert.deepEqual(plan.targets, [])
})

test('planDelete refuses a live descendant even when the selection is cold', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['root'], byId, childrenOf, {
    isLive: (id) => id === 'grandchild',
    isPending: () => false,
  })
  assert.deepEqual(plan.blockers, [{ id: 'grandchild', reason: 'live' }])
  assert.deepEqual(plan.targets, [], 'a live descendant blocks the whole subtree')
})

test('planDelete reports an unknown id as missing', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['nope'], byId, childrenOf, { isLive: () => false, isPending: () => false })
  assert.deepEqual(plan.blockers, [{ id: 'nope', reason: 'missing' }])
})

test('planDelete treats an unmaterialised session as pending', () => {
  const records = [record('root'), record('ghost', { persisted: false, live: false })]
  const { byId, childrenOf } = indexSessions(records, [])
  const plan = planDelete(['ghost'], byId, childrenOf, {
    isLive: () => false,
    isPending: (id) => id === 'ghost',
  })
  assert.deepEqual(plan.blockers, [{ id: 'ghost', reason: 'live' }])
})

test('planDelete deduplicates repeated requests', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['unrelated', 'unrelated'], byId, childrenOf, {
    isLive: () => false,
    isPending: () => false,
  })
  assert.deepEqual(plan.targets, ['unrelated'])
})

test('planDelete refuses the current session even when it is only an expanded target', () => {
  // The caller selects the parent; the session they are actually looking at is
  // one of its descendants. Deleting the subtree would take that session with
  // it, so the plan must refuse rather than quietly drop one member.
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['root'], byId, childrenOf, {
    isLive: () => false,
    isPending: () => false,
    currentSessionId: 'grandchild',
  })

  assert.deepEqual(plan.blockers, [{ id: 'grandchild', reason: 'current' }])
  assert.deepEqual(plan.targets, [], 'nothing is deleted while the current session is in the subtree')
  assert.ok(plan.expanded.includes('grandchild'), 'the refusal names a target the user did not select')
})

test('planDelete reports the current session once even when it is also selected', () => {
  const { byId, childrenOf } = indexSessions(family(), [])
  const plan = planDelete(['root', 'grandchild'], byId, childrenOf, {
    isLive: () => false,
    isPending: () => false,
    currentSessionId: 'grandchild',
  })

  assert.deepEqual(plan.blockers, [{ id: 'grandchild', reason: 'current' }])
})

test('titlesFromSnapshots reads the title snapshot the fold actually returns', () => {
  // Shaped exactly like @deepseek-ai/dsh-session-query's readTitleSnapshots:
  // one allSettled result per unique id, in first-occurrence order — and
  // `value.title` is a SessionTitleSnapshot, not the text. Reading it as a
  // string yields no titles at all, which is how every row of the manager once
  // fell back to a placeholder while the sidebar showed real names.
  const snapshot = (text) => ({
    title: text,
    messageSeqs: [8],
    source: { kind: 'provider', provider: 'session-title-first-prompt-llm' },
    eventSeq: 15,
    updatedAt: 1790559192873,
  })
  const results = [
    { status: 'fulfilled', value: { session: { id: 'b' }, title: snapshot('Second') } },
    { status: 'rejected', reason: new Error('session vanished mid-read') },
    { status: 'fulfilled', value: { session: { id: 'a' } } },
  ]

  // 'b' is requested twice: the reply collapses duplicates, so zipping by index
  // would shift every later title onto the wrong session.
  assert.deepEqual(titlesFromSnapshots(['a', 'b', 'b'], results), [undefined, 'Second', 'Second'])
  assert.deepEqual(titlesFromSnapshots(['b', 'a'], results), ['Second', undefined])
})

test('titlesFromSnapshots tolerates a bare title string', () => {
  // Not what the shipping harness sends, but a build that answers with the text
  // directly must not lose its titles.
  const results = [{ status: 'fulfilled', value: { session: { id: 'a' }, title: 'Plain' } }]
  assert.deepEqual(titlesFromSnapshots(['a'], results), ['Plain'])
})

test('titlesFromSnapshots ignores malformed and empty envelopes', () => {
  assert.deepEqual(titlesFromSnapshots(['a'], []), [undefined])
  assert.deepEqual(titlesFromSnapshots(['a'], [{ status: 'fulfilled' }]), [undefined])
  assert.deepEqual(titlesFromSnapshots(['a'], [{ status: 'fulfilled', value: { title: 'no id' } }]), [undefined])
  assert.deepEqual(titlesFromSnapshots(['a'], [{ status: 'fulfilled', value: { session: { id: 'a' }, title: 7 } }]), [
    undefined,
  ])
  assert.deepEqual(
    titlesFromSnapshots(['a'], [{ status: 'fulfilled', value: { session: { id: 'a' }, title: { title: '' } } }]),
    [undefined],
  )
  assert.deepEqual(
    titlesFromSnapshots(['a'], [{ status: 'fulfilled', value: { session: { id: 'a' }, title: { title: 7 } } }]),
    [undefined],
  )
  assert.deepEqual(titlesFromSnapshots([], [{ status: 'fulfilled', value: { session: { id: 'a' }, title: 'x' } }]), [])
})

test('indexSessions names rows exactly as the built-in session list does', () => {
  // The chain is the harness's own `displayTitleOf`: durable title, then the
  // working directory's basename, then the raw id.
  const records = [
    record('titled', { cwd: 'D:\\Tools\\dsh-session-delete' }),
    record('untitled', { cwd: 'D:\\Tools\\dsh-session-delete\\' }),
    record('no-cwd'),
    record('bare-separators', { cwd: '/' }),
  ]
  const { byId } = indexSessions(records, ['DSH 会话删除插件实现'])

  assert.equal(byId.get('titled').displayName, 'DSH 会话删除插件实现')
  assert.equal(byId.get('untitled').displayName, 'dsh-session-delete')
  assert.equal(byId.get('no-cwd').displayName, 'no-cwd')
  // A path that is only separators has no basename, so the id stands in — the
  // same place the harness's own projection lands.
  assert.equal(byId.get('bare-separators').displayName, 'bare-separators')
})

test('indexSessions keeps an empty title out of the name', () => {
  const { byId } = indexSessions([record('a', { cwd: 'C:\\work\\proj' })], [''])
  assert.equal(byId.get('a').title, '')
  assert.equal(byId.get('a').displayName, 'proj')
})

test('indexSessions names the parent of every child session', () => {
  // The manager is the only place a subagent row is listed at all, so a child
  // that cannot name its parent is an anonymous entry in a delete list.
  const { byId } = indexSessions(
    [
      record('parent', { cwd: 'D:\\Tools\\proj' }),
      record('child-a', { parentSession: 'parent', origin: 'subagent', cwd: 'D:\\Tools\\proj' }),
      record('grandchild', { parentSession: 'child-a', origin: 'subagent', cwd: 'D:\\Tools\\proj' }),
    ],
    ['制作dsh会话删除插件', '研究 DSH 存储', undefined],
  )

  assert.equal(byId.get('parent').parentName, undefined, 'a root names no parent')
  assert.equal(byId.get('child-a').parentName, '制作dsh会话删除插件')
  // A grandchild names its own parent, not the root of the family.
  assert.equal(byId.get('grandchild').parentName, '研究 DSH 存储')
})

test('indexSessions falls back to the parent id when the parent is gone', () => {
  // The parent may already be deleted, or an unfoldable listing may not have
  // named it. Either way the child still has to say whose it is.
  const { byId } = indexSessions(
    [record('orphan', { parentSession: 'session-beef-0000', origin: 'subagent' })],
    ['研究 DSH 存储'],
  )
  assert.equal(byId.get('orphan').parentName, 'session-beef-0000')
})

test('indexSessions leaves a self-parenting header unnamed', () => {
  const { byId } = indexSessions([record('self', { parentSession: 'self' })], [])
  assert.equal(byId.get('self').parentName, undefined)
  assert.equal(byId.get('self').descendantCount, 0)
})

test('indexSessions names a delegated child after its task label', () => {
  // A child's folded title is its first prompt — "You are researching the DSH…"
  // for every sibling of one batch — so three subagents spawned for three
  // different jobs used to read identically in the manager.
  const labels = new Map([
    ['child-a', 'Research DSH session storage'],
    ['unrelated', 'not a child, must be ignored'],
  ])
  const { byId } = indexSessions(family(), ['Root', 'Child A', 'Child B', 'Grandchild', 'Unrelated'], labels)

  assert.equal(byId.get('child-a').displayName, 'Research DSH session storage')
  assert.equal(byId.get('child-a').title, 'Child A', 'the folded title is kept for a fallback')
  // Only a delegated child takes a label; a root that happens to be in the map
  // keeps the name the built-in list gives it.
  assert.equal(byId.get('unrelated').displayName, 'Unrelated')
  // No label for this child, so the title still stands in.
  assert.equal(byId.get('child-b').displayName, 'Child B')
})

test('indexSessions names a grandchild parent after the parent label', () => {
  // The parent's *display* name is what a child points at, so a child of a
  // subagent reads as belonging to the task, not to the parent's first prompt.
  const { byId } = indexSessions(
    [
      record('parent', { cwd: 'D:\\Tools\\proj' }),
      record('child', { parentSession: 'parent', origin: 'subagent', cwd: 'D:\\Tools\\proj' }),
      record('grandchild', { parentSession: 'child', origin: 'subagent', cwd: 'D:\\Tools\\proj' }),
    ],
    ['制作dsh会话删除插件', 'You are researching the DSH', 'You are researching the DSH'],
    new Map([['child', 'Research DSH session storage']]),
  )

  assert.equal(byId.get('child').parentName, '制作dsh会话删除插件')
  assert.equal(byId.get('grandchild').parentName, 'Research DSH session storage')
})

test('subagentLabelFrom reads the label off the child descriptor event', () => {
  // Shaped like a real log: the descriptor is the child's own first event and
  // carries the task the subagent was spawned with.
  const events = [
    { type: 'session', data: { id: 'x' } },
    {
      type: 'subagent/descriptor',
      data: {
        version: 3,
        mode: 'continuable',
        provider: 'spawn',
        label: 'Research DSH session storage',
        agentProvider: 'deepseek-official',
      },
    },
    { type: 'subagent/descriptor', data: { label: 'a later descriptor must not win' } },
  ]

  assert.equal(subagentLabelFrom(events), 'Research DSH session storage')
})

test('subagentLabelFrom reports no label for anything undeclared', () => {
  assert.equal(subagentLabelFrom([]), undefined)
  assert.equal(subagentLabelFrom([{ type: 'session', data: {} }]), undefined, 'no descriptor at all')
  assert.equal(subagentLabelFrom([{ type: 'subagent/descriptor' }]), undefined, 'descriptor without a payload')
  assert.equal(subagentLabelFrom([{ type: 'subagent/descriptor', data: {} }]), undefined, 'payload without a label')
  assert.equal(subagentLabelFrom([{ type: 'subagent/descriptor', data: { label: '' } }]), undefined, 'empty label')
  assert.equal(subagentLabelFrom([{ type: 'subagent/descriptor', data: { label: 7 } }]), undefined, 'non-string label')
})

test('displayNameOf prefers the task label over every other name', () => {
  const session = { id: 'child', title: 'You are researching the DSH', cwd: 'D:\\Tools\\proj', label: 'Research DSH session storage' }

  assert.equal(displayNameOf(session), 'Research DSH session storage')
  assert.equal(displayNameOf({ ...session, label: undefined }), 'You are researching the DSH')
  assert.equal(displayNameOf({ ...session, label: '', title: undefined }), 'proj')
  assert.equal(displayNameOf({ ...session, label: '', title: undefined, cwd: undefined }), 'child')
})

test('summarizeHostSessions asks for labels of delegated children only', async () => {
  const calls = []
  const host = {
    async listSessions() {
      return family()
    },
    async readTitles(ids) {
      calls.push({ kind: 'titles', ids })
      return ids.map((id) => `title of ${id}`)
    },
    async readSubagentLabels(ids) {
      calls.push({ kind: 'labels', ids })
      return new Map([
        ['child-a', 'Research DSH session storage'],
        ['grandchild', 'Research plugin packaging and install'],
      ])
    },
  }

  const { records, summaries, byId } = await summarizeHostSessions(host)

  assert.deepEqual(calls[0], { kind: 'titles', ids: ['root', 'child-a', 'child-b', 'grandchild', 'unrelated'] })
  assert.deepEqual(calls[1], { kind: 'labels', ids: ['child-a', 'child-b', 'grandchild'] }, 'roots are not asked for a label')
  assert.equal(byId.get('child-a').displayName, 'Research DSH session storage')
  assert.equal(byId.get('grandchild').displayName, 'Research plugin packaging and install')
  assert.equal(byId.get('grandchild').parentName, 'Research DSH session storage', 'the parent is named by its task')
  assert.equal(byId.get('child-b').displayName, 'title of child-b', 'a child whose log declares no label keeps its title')
  assert.equal(summaries.length, records.length)
})

test('summarizeHostSessions skips the label read when nothing is delegated', async () => {
  // One log read per child is real work: a corpus with no subagent must not pay
  // for a read that cannot answer.
  const calls = []
  const host = {
    async listSessions() {
      return [record('solo', { cwd: 'D:\\Tools\\proj' })]
    },
    async readTitles() {
      calls.push('titles')
      return ['Solo']
    },
    async readSubagentLabels() {
      calls.push('labels')
      return new Map()
    },
  }

  const { byId } = await summarizeHostSessions(host)

  assert.deepEqual(calls, ['titles'])
  assert.equal(byId.get('solo').displayName, 'Solo')
})
