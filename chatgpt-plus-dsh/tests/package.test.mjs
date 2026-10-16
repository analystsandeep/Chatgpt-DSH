// Packaging and DSH compatibility checks (what `dsh plugin add` and the loader rely on).
import './helpers.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import * as constants from '../lib/constants.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

// Minimal semver range check covering the forms DSH peers use (exact, ^, ~, >=, ||), with
// prereleases participating like dsh-app-boot's `includePrerelease: true`.
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim())
  if (!m) throw new Error(`bad version ${version}`)
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}
function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key]
  if (a.pre.length === 0 || b.pre.length === 0) return (a.pre.length === 0 ? 1 : 0) - (b.pre.length === 0 ? 1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const [x, y] = [a.pre[i], b.pre[i]]
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny && +x !== +y) return +x - +y
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
function satisfies(version, range) {
  const v = parse(version)
  return range.split('||').some((part) => {
    const r = part.trim()
    if (r.startsWith('^')) {
      const base = parse(r.slice(1))
      const upper = base.major > 0 ? { major: base.major + 1, minor: 0, patch: 0, pre: ['0'] } : base.minor > 0 ? { major: 0, minor: base.minor + 1, patch: 0, pre: ['0'] } : { major: 0, minor: 0, patch: base.patch + 1, pre: ['0'] }
      return compare(v, base) >= 0 && compare(v, upper) < 0
    }
    if (r.startsWith('~')) {
      const base = parse(r.slice(1))
      return compare(v, base) >= 0 && compare(v, { major: base.major, minor: base.minor + 1, patch: 0, pre: ['0'] }) < 0
    }
    if (r.startsWith('>=')) return compare(v, parse(r.slice(2))) >= 0
    return compare(v, parse(r)) === 0
  })
}

test('the semver helper agrees with known DSH ranges', () => {
  assert.equal(satisfies('0.2.1-alpha.3', '^0.2.0-rc.2 || ^0.2.1-alpha.1'), true)
  assert.equal(satisfies('0.2.0-rc.2', '^0.2.0-rc.2 || ^0.2.1-alpha.1'), true)
  assert.equal(satisfies('0.2.1-alpha.3', '0.2.1-alpha.3'), true)
  assert.equal(satisfies('0.2.1-alpha.3', '^0.1.7'), false)
  assert.equal(satisfies('0.3.0', '^0.2.0-rc.2'), false)
})

test('manifest: ESM entry, client export and the required dsh.bundle.patch', () => {
  assert.equal(manifest.name, 'chatgpt-plus-dsh')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['.'], './lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.exports['./package.json'], './package.json')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/en.json']) assert.ok(existsSync(join(ROOT, file)), file)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(constants.PACKAGE_VERSION, manifest.version)
})

test('DSH compatibility gate: no @deepseek-ai/dsh* peer excludes 0.2.1-alpha.3 or 0.2.0-rc.2', () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    for (const runtime of ['0.2.1-alpha.3', '0.2.0-rc.2']) assert.ok(satisfies(runtime, range), `${name}@${range} excludes ${runtime}`)
  }
})

test('declares no peer or runtime dependencies (link: installs stay warning-free, nothing to npm install)', () => {
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), [])
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [])
})

test('bundle patch inserts one row whose id differs from the package name', () => {
  const yaml = read('cordis.patch.yml').replace(/\r\n/g, '\n')
  assert.match(yaml, /^- insert:\n/m)
  const id = /^\s+- id:\s*([\w-]+)\s*$/m.exec(yaml)?.[1]
  const name = /^\s+name:\s*'([^']+)'\s*$/m.exec(yaml)?.[1]
  assert.equal(id, 'chatgpt-plus')
  assert.equal(name, manifest.name)
  assert.notEqual(id, name)
})

test('locale metadata for the plugin card', () => {
  const locale = JSON.parse(read('locale/en.json'))
  assert.equal(typeof locale.meta.title, 'string')
  assert.equal(typeof locale.meta.description, 'string')
  assert.ok(locale.meta.title.length > 0 && locale.meta.description.length > 0)
})

test('ships no documentation files', () => {
  const entries = readdirSync(ROOT)
  assert.ok(!entries.some((e) => /^(readme|install|usage|changelog)/i.test(e) || /\.md$/i.test(e)), entries.join(', '))
  assert.ok(!entries.includes('docs'))
})

test('host modules import only Node built-ins and sibling modules', () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
  for (const file of readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js') && f !== 'client.js')) {
    const source = read(`lib/${file}`)
    const specifiers = [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('./') || builtins.has(specifier), `${file} imports ${specifier}`)
    }
  }
})

test('client bundle uses the module-loader factory form and only platform seed modules', () => {
  const source = read('lib/client.js').replace(/\r\n/g, '\n')
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{\n\tid: "chatgpt-plus-dsh",\n\tfactory: \(require\) => \{/m)
  const requires = [...source.matchAll(/\brequire\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(requires)].sort(), ['@deepseek-ai/dsh-client-ui-primitives', 'react'])
  assert.ok(!/\bimport\s|\bexport\s/.test(source.replace(/\/\/.*$/gm, '')))
})

test('no shell is ever used to run processes', () => {
  for (const file of readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))) {
    const code = read(`lib/${file}`).replace(/\/\/.*$/gm, '')
    assert.ok(!/\bshell:\s*true/.test(code), `${file}: shell: true`)
    assert.ok(!/\bexecSync\b|\bspawnSync\b|(?<![.\w$])exec\(/.test(code), `${file}: exec/execSync/spawnSync`)
    assert.ok(!/['"](?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|bash|sh|tmux|wsl(?:\.exe)?)['"]/.test(code), `${file}: shell binary`)
  }
})

test('identifiers never collide with dsh-chatgpt-sub', () => {
  assert.equal(constants.PROVIDER_ID, 'chatgpt-plus')
  assert.notEqual(constants.PROVIDER_ID, 'openai-codex')
  assert.equal(constants.CREDENTIAL_KEY, 'chatgpt-plus/account')
  assert.match(constants.CREDENTIAL_KEY, /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
  assert.notEqual(constants.RPC_PREFIX, '/_dsh/dsh-chatgpt-sub')
  assert.equal(constants.DATA_DIR_NAME, 'chatgpt-plus-dsh')
  // Comments explain the separation and name the other plugin's identifiers; code must not.
  const code = readdirSync(join(ROOT, 'lib')).map((f) => read(`lib/${f}`).replace(/\/\/.*$/gm, '')).join('\n')
  assert.ok(!code.includes('OPENAI_CODEX_API_KEY'), 'never touches the other plugin\'s credential reference')
  assert.ok(!code.includes('dsh-chatgpt-sub'), 'never addresses the other plugin')
  assert.ok(!/\.codex['"/\\]|auth\.json/.test(code), 'never reads ~/.codex/auth.json')
})
