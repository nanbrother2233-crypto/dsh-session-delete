/**
 * Workspace tree guard — detects the dev-harness directory loop.
 *
 * `.devhome/profiles/web/node_modules/dsh-session-delete` is a *junction* back
 * to this repository's root, which is how the scratch profile loads the plugin
 * without publishing it. Because `.devhome` also lives inside the repository,
 * that junction makes the tree cyclic: a recursive walk of the repository root
 * descends into the repository root again, forever.
 *
 * Walking such a tree does not fail politely. It exhausts path length, memory
 * or patience, and a walk performed *inside* the DSH host process — by a file
 * watcher, a scan, or an agent's own glob — takes that process (and the session
 * running in it) down with it.
 *
 * This script walks the tree the safe way: every child is `lstat`ed and a link
 * is recorded, never entered. It then classifies each link and fails only on an
 * unsanctioned loop, so the guard catches a new cycle instead of just describing
 * the known one.
 *
 *   npm run check:tree
 *
 * Exit code 0 means the tree can be traversed safely by anything that refuses
 * to follow links. It does NOT make a naive `rm -rf`-style walk safe.
 */

import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root — the directory this script must never be walked from naively. */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Directories that are never worth descending into, and cannot hide a loop we ship. */
const SKIP = new Set(['.git', 'node_modules', '.scratch'])

/** The one loop the dev harness needs, relative to {@link ROOT}. */
const DEV_LINK = ['.devhome', 'profiles', 'web', 'node_modules', 'dsh-session-delete'].join(sep)

/** Links that legitimately re-enter the tree without closing a cycle. */
const SANCTIONED_REENTRY = new Set([
  ['.devhome', 'profiles', 'web', 'node_modules', 'react'].join(sep),
  ['.devhome', 'profiles', 'web', 'node_modules', 'loose-envify'].join(sep),
])

/** Compare paths with Windows' case-insensitivity, and tolerate a trailing separator. */
function normalize(path) {
  const stripped = path.endsWith(sep) ? path.slice(0, -1) : path
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped
}

/** Whether `candidate` is `ancestor` itself or lives underneath it. */
function isInside(ancestor, candidate) {
  const a = normalize(ancestor)
  const c = normalize(candidate)
  return c === a || c.startsWith(a + sep)
}

/**
 * Collect every link reachable without following one.
 *
 * @param start - absolute directory to walk.
 * @returns absolute paths of links, plus the number of directories visited.
 */
async function findLinks(start) {
  const links = []
  const queue = [start]
  let visited = 0
  while (queue.length > 0) {
    const current = queue.pop()
    visited += 1
    let entries
    try {
      entries = await readdir(current)
    } catch {
      // An unreadable directory cannot hide a loop we need to report.
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let stats
      try {
        stats = await lstat(full)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) {
        links.push(full)
        continue
      }
      if (!stats.isDirectory()) continue
      if (SKIP.has(entry)) continue
      queue.push(full)
    }
  }
  return { links, visited }
}

/** Show a path the way a reader will retype it: relative when it is inside the repo. */
function display(absolute) {
  if (normalize(absolute) === normalize(ROOT)) return '.'
  return isInside(ROOT, absolute) ? relative(ROOT, absolute) : absolute
}

/**
 * Classify one link by where it actually resolves.
 *
 * @param link - absolute link path.
 * @returns the kind, the resolved target, and whether following it is safe.
 */
async function classify(link) {
  let target
  try {
    target = await realpath(link)
  } catch {
    return { kind: 'broken', target: '(unresolved)', cycles: false }
  }
  // A link that resolves to one of its own ancestors closes a loop.
  if (isInside(target, link) || normalize(target) === normalize(ROOT)) {
    return { kind: 'cycle', target, cycles: true }
  }
  if (isInside(ROOT, target)) return { kind: 're-entry', target, cycles: false }
  return { kind: 'external', target, cycles: false }
}

const { links, visited } = await findLinks(ROOT)

// The dev harness keeps its links inside a `node_modules` directory, which the
// pruned walk skips on purpose. Inspect that one directory's immediate children
// rather than descending into an installed dependency tree.
const DEV_MODULES = join(ROOT, '.devhome', 'profiles', 'web', 'node_modules')
let devHarnessPresent = true
try {
  for (const entry of await readdir(DEV_MODULES)) {
    const full = join(DEV_MODULES, entry)
    const stats = await lstat(full).catch(() => undefined)
    if (stats?.isSymbolicLink() === true && !links.includes(full)) links.push(full)
  }
} catch {
  devHarnessPresent = false
}

/** Every loop or re-entry this repository is known to need. */
const SANCTIONED = new Set([DEV_LINK, ...SANCTIONED_REENTRY])

const cycles = []
const reentries = []
const external = []
const broken = []

for (const link of links) {
  const relativePath = display(link)
  const result = await classify(link)
  const entry = { path: relativePath, target: display(result.target) }
  if (result.kind === 'cycle') cycles.push(entry)
  else if (result.kind === 're-entry') reentries.push(entry)
  else if (result.kind === 'broken') broken.push(entry)
  else external.push(entry)
}

/** Report the loop only when it is not the sanctioned dev-harness one. */
const problems = []
for (const entry of cycles) {
  if (!SANCTIONED.has(entry.path)) problems.push(`unsanctioned loop: ${entry.path} -> ${entry.target}`)
}
for (const entry of reentries) {
  if (!SANCTIONED.has(entry.path)) {
    problems.push(`unexpected link back into the repository: ${entry.path} -> ${entry.target}`)
  }
}

const devLink = cycles.find((entry) => entry.path === DEV_LINK)

process.stdout.write(`dsh-session-delete: tree check over ${String(visited)} directories (links not followed)\n`)
if (devLink !== undefined) {
  process.stdout.write(
    `  dev harness loop (expected): ${devLink.path} -> ${devLink.target}\n` +
      '    following this link re-enters the repository, without end\n',
  )
} else if (!devHarnessPresent) {
  process.stdout.write('  dev harness: absent — .devhome is not linked, nothing can recurse\n')
} else {
  problems.push(`dev harness link missing: ${DEV_LINK} is not a link; the scratch profile cannot load the plugin`)
}
for (const entry of reentries) {
  const note = SANCTIONED.has(entry.path) ? 'expected' : 'UNEXPECTED'
  process.stdout.write(`  re-entry (${note}): ${entry.path} -> ${entry.target}\n`)
}
for (const entry of external) {
  process.stdout.write(`  external link: ${entry.path} -> ${entry.target}\n`)
}
for (const entry of broken) {
  process.stdout.write(`  broken link: ${entry.path} -> ${entry.target}\n`)
}

if (problems.length > 0) {
  process.stderr.write('\nFAIL: the workspace tree contains an unsanctioned directory loop.\n')
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.stderr.write(
    '\nAnything that walks this repository recursively will follow it and hang or die.\n' +
      'Remove the link, or teach the walker to skip reparse points, before building or packing.\n',
  )
  process.exitCode = 1
} else {
  process.stdout.write(
    '  ok — no unsanctioned loop\n\n' +
      `RULE: never walk ${display(ROOT)} recursively.\n` +
      '      Exclude .devhome (and .git, node_modules, .scratch) from every scan, glob and grep.\n' +
      '      See the Development section of README.md.\n',
  )
}
