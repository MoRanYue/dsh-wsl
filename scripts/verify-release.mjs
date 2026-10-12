// Verify a release across all three channels, after the tag workflow has finished.
//
//   node scripts/verify-release.mjs 1.12.2            # wait for the run, then verify
//   node scripts/verify-release.mjs 1.12.2 --no-wait   # verify only
//
// Unlike the run's colour, this reads the registry and the release asset themselves — a green
// run only means every step exited 0, and the npm step is allowed to warn and exit 0 when
// NPM_TOKEN is missing, and prints its "published" notice from package.json rather than from
// the registry. Run it with a proxy in reach if the machine needs one for github.com:
//
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:10090 node scripts/verify-release.mjs 1.12.2
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const version = process.argv[2]
const noWait = process.argv.includes('--no-wait')
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/verify-release.mjs <version> [--no-wait]')
  process.exit(2)
}

const TAG = `v${version}`
const REPO = 'XINY11451/dsh-wsl'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function get(url, { raw = false, attempts = 4 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return raw ? Buffer.from(await response.arrayBuffer()) : await response.text()
    } catch (error) {
      if (attempt === attempts) throw error
      await sleep(1500 * attempt)
    }
  }
  throw new Error(`unreachable: ${url}`)
}

/** Read one file out of a .tgz without unpacking it. */
function fileInTarball(tgz, wanted) {
  const tar = gunzipSync(tgz)
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (full === wanted) return tar.subarray(offset + 512, offset + 512 + size).toString('utf8')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

let conclusion = null
if (!noWait) {
  console.log(`waiting for the ${TAG} workflow ...`)
  for (let tick = 1; tick <= 40; tick += 1) {
    const runs = JSON.parse(await get(`https://api.github.com/repos/${REPO}/actions/runs?per_page=10&cb=${Date.now()}`))
    const run = (runs.workflow_runs ?? []).find((entry) => entry.head_branch === TAG)
    if (run === undefined) console.log(`  [${tick}] no run for ${TAG} yet`)
    else if (run.status === 'completed') {
      conclusion = run.conclusion
      console.log(`  [${tick}] completed -> ${run.conclusion}  ${run.html_url}`)
      break
    } else console.log(`  [${tick}] ${run.status}`)
    await sleep(15000)
  }
  if (conclusion === null) {
    console.log('RESULT: the workflow did not finish in time; re-run with --no-wait once it has')
    process.exit(1)
  }
}

console.log('\nrelease asset (the market installs from this fixed URL):')
const release = JSON.parse(await get(`https://api.github.com/repos/${REPO}/releases/latest?cb=${Date.now()}`))
const asset = await get(`https://github.com/${REPO}/releases/latest/download/dsh-wsl.tgz?cb=${Date.now()}`, { raw: true })
const assetVersion = JSON.parse(fileInTarball(asset, 'package/package.json') ?? '{}').version
console.log(`  latest tag: ${release.tag_name}`)
console.log(`  asset: ${asset.length} bytes  sha256=${sha256(asset)}  package.json version=${assetVersion}`)

console.log('\nnpm:')
const packument = JSON.parse(await get(`https://registry.npmjs.org/dsh-wsl-tool?cb=${Date.now()}`))
const npmTarball = packument.versions?.[version] === undefined
  ? null
  : await get(`https://registry.npmjs.org/dsh-wsl-tool/-/dsh-wsl-tool-${version}.tgz?cb=${Date.now()}`, { raw: true })
console.log(`  dist-tags.latest = ${packument['dist-tags']?.latest}`)
console.log(`  ${version} present = ${npmTarball !== null}`)
if (npmTarball !== null) console.log(`  tarball: ${npmTarball.length} bytes  sha256=${sha256(npmTarball)}`)

const problems = []
if (release.tag_name !== TAG) problems.push(`the latest release is ${release.tag_name}, not ${TAG}`)
if (assetVersion !== version) problems.push(`the release asset carries ${assetVersion}`)
if (npmTarball === null) {
  problems.push(`${version} is NOT on npm — read the "Publish to npm" step of the run; a green run `
    + 'does not prove it published (no NPM_TOKEN, or the publish failed after a notice)')
} else {
  if (packument['dist-tags']?.latest !== version) problems.push(`npm latest is ${packument['dist-tags']?.latest}`)
  if (npmTarball.length !== asset.length || sha256(npmTarball) !== sha256(asset)) {
    problems.push('the release asset and the npm tarball are NOT byte-identical')
  }
}
console.log('')
for (const problem of problems) console.log(`PROBLEM: ${problem}`)
console.log(problems.length === 0
  ? `RESULT: ${TAG} is consistent across the release asset, npm and the tag`
  : `RESULT: ${problems.length} problem(s)`)
process.exit(problems.length === 0 ? 0 : 1)
