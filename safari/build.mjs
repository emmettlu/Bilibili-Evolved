// Build the Safari Userscripts edition from the upstream release.
// Usage: node safari/build.mjs [path/to/upstream.user.js]
// Without an argument the upstream file is downloaded from UPSTREAM_URL.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_URL =
  'https://raw.githubusercontent.com/the1812/Bilibili-Evolved/master/dist/bilibili-evolved.user.js'
const RAW_BASE =
  'https://raw.githubusercontent.com/emmettlu/Bilibili-Evolved/refs/heads/safari/userscripts/dist'
const OUT_NAME = 'bilibili-evolved.safari'
// Bump when adapter.js changes so Userscripts sees a newer version
const ADAPTER_REVISION = 4

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const download = async url => {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${url}`)
  }
  return response.text()
}

const [localSource] = process.argv.slice(2)
const original = localSource ? readFileSync(localSource, 'utf8') : await download(UPSTREAM_URL)
const adapter = readFileSync(join(root, 'safari/adapter.js'), 'utf8')

const end = '// ==/UserScript=='
const endIndex = original.indexOf(end)
if (endIndex < 0) {
  throw new Error('metadata block not found')
}
const header = original.slice(0, endIndex)
const body = patchFeatureLoader(original.slice(endIndex + end.length))

// The feature loader evaluates component code inside `with (proxy)`, whose get trap returns
// window[name]. In page context that yields the page's Vue instead of the bundle's, and bare
// calls like btoa() receive the proxy as `this`, which WebKit rejects. Resolve names through
// __bevResolveGlobal (defined in adapter.js) instead.
function patchFeatureLoader(code) {
  const trap = /get:\((\w+),(\w+)\)=>(\w+)\.has\(\2\)\?\3\.get\(\2\):window\[\2\]/g
  const count = code.match(trap)?.length ?? 0
  if (count !== 1) {
    throw new Error(`feature loader get trap: expected 1 match, found ${count}`)
  }
  return code.replace(
    trap,
    (_, target, name, map) =>
      `get:(${target},${name})=>${map}.has(${name})?${map}.get(${name}):__bevResolveGlobal(${name})`,
  )
}

// Inline lodash, verified against the sha256 pinned by upstream @require
const requireMatch = header.match(/@require\s+(\S*lodash\S*)#sha256=([0-9a-f]+)/)
if (!requireMatch) {
  throw new Error('lodash @require not found')
}
const [, lodashUrl, pinned] = requireMatch
const lodash = await download(lodashUrl)
const actual = createHash('sha256').update(lodash).digest('hex')
if (actual !== pinned) {
  throw new Error(`lodash sha256 mismatch: ${pinned} != ${actual}`)
}

const upstreamVersion = header.match(/@version\s+(\S+)/)?.[1]
if (!upstreamVersion) {
  throw new Error('@version not found')
}
const version = `${upstreamVersion}.${ADAPTER_REVISION}`

const drop = /^\/\/ @(version|updateURL|downloadURL|require|connect|icon64|grant)\b/
const lines = header.split('\n').filter(l => l.trim() && !drop.test(l))
const pad = key => `// @${key}`.padEnd(20)
const nameIndex = lines.findIndex(l => l.startsWith('// @name'))
lines.splice(
  nameIndex + 1,
  0,
  `${pad('namespace')}https://github.com/emmettlu/Bilibili-Evolved/tree/safari/userscripts`,
  `${pad('version')}${version}`,
  `${pad('updateURL')}${RAW_BASE}/${OUT_NAME}.meta.js`,
  `${pad('downloadURL')}${RAW_BASE}/${OUT_NAME}.user.js`,
)
const runAtIndex = lines.findIndex(l => l.startsWith('// @run-at'))
lines.splice(
  runAtIndex + 1,
  0,
  `${pad('inject-into')}content`,
  ...['GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues', 'GM_xmlhttpRequest'].map(
    g => `${pad('grant')}${g}`,
  ),
)
const descIndex = lines.findIndex(l => l.startsWith('// @description'))
lines[descIndex] += ' (Safari Userscripts 适配版)'
const meta = `${lines.join('\n')}\n${end}\n`

const [beforeLodash, rest] = adapter.split('/*@@LODASH@@*/')
const [beforeMain, afterMain] = rest.split('/*@@MAIN@@*/')
if (afterMain === undefined) {
  throw new Error('adapter placeholders not found')
}
const result = `${meta}${beforeLodash}${lodash}\n${beforeMain}${body.trim()}\n${afterMain}`

const distDir = join(root, 'dist')
mkdirSync(distDir, { recursive: true })
writeFileSync(join(distDir, `${OUT_NAME}.user.js`), result)
writeFileSync(join(distDir, `${OUT_NAME}.meta.js`), meta)
console.log(`built ${OUT_NAME} ${version}`)
