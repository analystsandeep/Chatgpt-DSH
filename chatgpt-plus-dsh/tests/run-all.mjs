// Offline test runner: `node tests/run-all.mjs`
//
// Runs every tests/*.test.mjs with Node's built-in test runner, one child process per file
// (spawned with process.execPath, no shell), sequentially so redirect-listener ports and
// timers never interfere. Exits non-zero if any test fails. Works on Windows and POSIX with
// Node 20.11+ (verified on Node 24); no dependencies, no network access.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const packageDir = dirname(testsDir)
// A file:// URL: a raw Windows path (C:\...) is not a valid module specifier for --test-reporter.
const reporter = pathToFileURL(join(testsDir, 'reporter.mjs')).href
const files = readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).sort()
const PER_FILE_TIMEOUT_MS = 180_000

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--test', `--test-reporter=${reporter}`, join(testsDir, file)], {
      cwd: packageDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, PER_FILE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ file, code: timedOut ? 1 : code, stdout, stderr, timedOut, ms: Date.now() - started })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ file, code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut, ms: Date.now() - started })
    })
  })
}

const startedAt = Date.now()
console.log(`chatgpt-plus-dsh test suite - Node ${process.version} (${process.platform} ${process.arch})`)
const totals = { files: files.length, failedFiles: 0, pass: 0, fail: 0, skip: 0 }
for (const file of files) {
  const result = await runFile(file)
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
  const counts = { pass: 0, fail: 0, skip: 0 }
  for (const line of lines) {
    if (line.startsWith('PASS ')) counts.pass += 1
    else if (line.startsWith('FAIL ')) counts.fail += 1
    else if (line.startsWith('SKIP ') || line.startsWith('TODO ')) counts.skip += 1
  }
  const failed = result.code !== 0 || counts.fail > 0
  console.log(`\n${failed ? 'FAIL' : 'ok  '} ${file}  (${counts.pass} passed, ${counts.fail} failed${counts.skip ? `, ${counts.skip} skipped` : ''}, ${(result.ms / 1000).toFixed(1)}s)`)
  for (const line of lines) console.log(`  ${line}`)
  if (failed) {
    totals.failedFiles += 1
    if (result.timedOut) console.log(`  Timed out after ${PER_FILE_TIMEOUT_MS / 1000}s`)
    const stderr = result.stderr.trim()
    if (stderr) console.log(stderr.split(/\r?\n/).map((line) => `  | ${line}`).join('\n'))
    if (counts.fail === 0) counts.fail = 1
  }
  totals.pass += counts.pass
  totals.fail += counts.fail
  totals.skip += counts.skip
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(`\n${totals.fail === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped - ${totals.files} files in ${seconds}s`)
process.exitCode = totals.fail === 0 ? 0 : 1
