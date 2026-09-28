/**
 * Run every `test/*.test.mjs` in one process.
 *
 * `node --test` spawns a child per file, which needs piped stdio; under the
 * harness's confined Windows sandbox that spawn fails with EPERM. Importing the
 * files here keeps the runner in-process — `node:test` still drives and reports
 * every case.
 */

import { readdir } from 'node:fs/promises'

const directory = new URL('../test/', import.meta.url)
const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.test.mjs')).sort()

if (entries.length === 0) {
  process.stderr.write('no test files found\n')
  process.exitCode = 1
} else {
  for (const entry of entries) await import(new URL(entry, directory))
}
