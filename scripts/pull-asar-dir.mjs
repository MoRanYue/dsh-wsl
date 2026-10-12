// Extract one directory out of an Electron `app.asar` into a real directory.
//
// Why this exists: `npm run test:real` imports the DSH platform modules
// (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-subprocess-local`, …) by path, and on a desktop
// installation those live INSIDE `app.asar` — an archive Node cannot import from. The
// profile's own `node_modules` holds only `schemastery`/`cosmokit`, so the real-provider
// gate silently skips unless someone extracts the tree first. `PUBLISHING.md` step 1 uses
// this script for exactly that.
//
// Usage:
//   node scripts/pull-asar-dir.mjs <app.asar> <destination> <path/inside/asar>
//
// The archive's directory is written to `<destination>/<path/inside/asar>`, so extracting
// `dsh/node_modules` yields `<destination>/dsh/node_modules/...` — point
// `DSH_SUBPROCESS_LOCAL` at that inner directory.

import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [archive, destination, prefix] = process.argv.slice(2)
if (archive === undefined || destination === undefined || prefix === undefined) {
  console.error('usage: node scripts/pull-asar-dir.mjs <app.asar> <destination> <path/inside/asar>')
  process.exit(2)
}

// The asar header: 16 bytes (a size pickle), then a JSON directory listing. Offsets in the
// listing are relative to the end of the header, and 4-byte aligned — for FILES only, which
// is why the sizes here are read but never used to seek.
const fd = openSync(archive, 'r')
try {
  const sizeBuf = Buffer.alloc(16)
  readSync(fd, sizeBuf, 0, 16, 0)
  const jsonSize = sizeBuf.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonSize)
  readSync(fd, jsonBuf, 0, jsonSize, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const dataOffset = 16 + jsonSize

  const wanted = prefix.replace(/^\/+|\/+$/g, '').split('/')
  let node = header
  for (const segment of wanted) {
    node = node?.files?.[segment]
    if (node === undefined) {
      console.error(`not in the archive: ${prefix}`)
      process.exit(1)
    }
  }

  let files = 0
  let bytes = 0
  const walk = (entry, parts) => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const ownPath = [...parts, name]
      if (child.files !== undefined) {
        walk(child, ownPath)
        continue
      }
      if (child.offset === undefined) continue
      const size = Number(child.size)
      const out = join(resolve(destination), ...wanted, ...ownPath)
      mkdirSync(dirname(out), { recursive: true })
      const buffer = Buffer.alloc(size)
      readSync(fd, buffer, 0, size, dataOffset + Number(child.offset))
      writeFileSync(out, buffer)
      files += 1
      bytes += size
    }
  }
  walk(node, [])
  console.log(`extracted ${files} files, ${(bytes / 1048576).toFixed(1)} MB -> ${join(resolve(destination), ...wanted)}`)
} finally {
  closeSync(fd)
}
