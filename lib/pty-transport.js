// A terminal transport for DSH builds whose `terminalController` no longer exposes
// `follow`/`write`.
//
// DSH 0.2.1 replaced that pair with `attach(agent, id, signal)`, which reads the CALLER's
// Remote invocation to obtain its input uplink — a host-side plugin has no such invocation,
// so a plugin cannot type into the browser's terminal at all. What a plugin can still do is
// what the platform's own persistent-shell tools do: own a PTY through the subprocess
// provider (`spawnTerminal`), and drive it itself.
//
// This module wraps one such PTY in the SAME five calls `wsl-term` already uses —
// `list`, `create`, `follow`, `write`, `close` — so the tool's protocol (helper definition,
// per-call nonce, marker parsing, readiness gating, detachable attachment) works unchanged on
// either generation of the host.
//
// The one thing it cannot offer is the sidebar: these shells are not the app's browser
// terminals, so nobody can watch or join them. The tool says so when this transport is in use.
//
// Every terminal is the calling Agent's: one PTY per allocated id, closed only by `close` or a
// session ending. Nothing is persisted — a restart drops them, exactly like the old ones.

import { resolveDistro } from './runner.js'
import { windowsPathToWsl } from './paths.js'

/** Geometry a tool-opened terminal gets when nobody asks for another. */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
/** Retained tail of one shell's output; the tool only ever reads the markers near the end. */
const MAX_BUFFER_CHARS = 200_000
/** How long a terminated PTY may take to settle before the close is reported as done. */
const CLOSE_GRACE_MS = 1_000
/** The platform's own wording, so `isClosedIdentity` in the tool matches. */
const CLOSED_MESSAGE = 'Terminal was closed in this Session'

/** Keep only the end of a growing capture: the markers a call waits for are recent. */
function keepTail(text) {
  return text.length <= MAX_BUFFER_CHARS ? text : text.slice(text.length - MAX_BUFFER_CHARS)
}

/**
 * Build a PTY-backed terminal transport over `ctx.subprocess`.
 *
 * @param ctx - the plugin context, used only to reach the subprocess provider.
 * @param config - resolved plugin configuration (`distro` decides which distribution runs).
 * @param subprocess - the provider carrying `spawnTerminal`; looked up when omitted.
 * @returns the transport, or null when this build has no terminal-capable subprocess provider.
 */
export function createPtyTransport({ ctx, config, subprocess }) {
  let provider = subprocess
  if (provider === undefined || provider === null) {
    try {
      provider = typeof ctx?.get === 'function' ? ctx.get('subprocess') : undefined
    } catch {
      // A host that faults on the lookup simply has no PTY transport; the tool says so.
      provider = undefined
    }
  }
  if (provider === undefined || provider === null || typeof provider.spawnTerminal !== 'function') return null

  /** sessionId -> Map<terminalId, record>; a plugin instance owns every shell it opened. */
  const sessions = new Map()
  /** Ids closed in this run: the platform refuses to reuse them, and so does this transport. */
  const closedIds = new Set()

  const bucket = (sessionId) => {
    const key = String(sessionId ?? '')
    let found = sessions.get(key)
    if (found === undefined) {
      found = new Map()
      sessions.set(key, found)
    }
    return found
  }
  const expect = (sessionId, id) => {
    const found = bucket(sessionId).get(String(id))
    if (found === undefined) throw new Error(`Terminal ${String(id)} does not exist in this Session`)
    return found
  }
  const publicInfo = (record) => ({ ...record.info, shell: { ...record.info.shell, args: [...record.info.shell.args] } })

  /** Wake every follower waiting for the next chunk. */
  const notify = (record) => {
    for (const wake of [...record.waiters]) wake()
  }

  /** Read the PTY for as long as it lives. One pump per terminal; followers share its output. */
  async function pump(record) {
    try {
      for await (const chunk of record.handle.output) {
        const text = record.decoder.decode(chunk, { stream: true })
        if (text.length === 0) continue
        record.buffer = keepTail(record.buffer + text)
        record.chunks.push(text)
        notify(record)
      }
      const rest = record.decoder.decode()
      if (rest.length > 0) {
        record.buffer = keepTail(record.buffer + rest)
        record.chunks.push(rest)
      }
    } catch {
      // A provider that fails mid-stream is an ended shell, reported through `handle.done`.
    }
    record.ended = true
    try {
      const outcome = await record.handle.done
      const exitCode = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null
      record.info = { ...record.info, state: 'exited', exitCode }
    } catch {
      record.info = { ...record.info, state: 'failed' }
    }
    notify(record)
  }

  /** Resolve when the terminal produces more output, ends, or the caller detaches. */
  function nextChange(record, signal) {
    if (record.ended || signal?.aborted === true) return Promise.resolve()
    return new Promise((resolve) => {
      const wake = () => {
        record.waiters.delete(wake)
        signal?.removeEventListener?.('abort', wake)
        resolve()
      }
      record.waiters.add(wake)
      signal?.addEventListener?.('abort', wake, { once: true })
    })
  }

  /** One attachment: the current capture as its screen, then each new chunk, then the exit. */
  async function* followStream(record, signal) {
    let sequence = 0
    let cursor = 0
    yield { type: 'snapshot', sequence: sequence++, screen: record.buffer, info: publicInfo(record), writable: true }
    while (true) {
      while (cursor < record.chunks.length) {
        const data = record.chunks[cursor]
        cursor += 1
        yield { type: 'output', data }
        yield { type: 'snapshot', sequence: sequence++, screen: record.buffer, info: publicInfo(record), writable: true }
      }
      if (record.ended) break
      if (signal?.aborted === true) return
      await nextChange(record, signal)
    }
    if (record.ended) yield { type: 'state', info: publicInfo(record), writable: false }
  }

  /**
   * Where the shell should start.
   *
   * The same rule the one-shot `wsl` tool follows, so the two tools agree about "the project":
   * the panel's fixed directory when one is set, otherwise the CALLING SESSION's workspace
   * (translated), otherwise the host's own directory. The old browser-terminal path inherited
   * whatever the user's terminal had; a PTY we open has to be told.
   */
  function startingDirectory(agent) {
    if (typeof config.defaultWorkdir === 'string' && config.defaultWorkdir !== '') return config.defaultWorkdir
    const sessionCwd = agent?.session?.header?.cwd
    return windowsPathToWsl(typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : process.cwd())
  }

  /** The launcher this transport runs, with the configured distribution and start directory. */
  async function launcher(agent, signal) {
    const distro = resolveDistro(undefined, config)
    let executable = 'wsl.exe'
    try {
      executable = await provider.resolveExecutable('wsl.exe', undefined, signal)
    } catch {
      // A host that cannot resolve it still lets Windows find it on PATH.
    }
    const workdir = startingDirectory(agent)
    const args = [
      ...(distro === null ? [] : ['-d', distro]),
      // `--cd` is the launcher's own directory switch: it applies before the shell starts, so the
      // prompt is already in the right tree (a `cd` inside `-e bash -l` would fight the profile).
      '--cd', workdir,
      '-e', 'bash', '-l',
    ]
    return { executable, args, workdir }
  }

  return {
    /** Marks the generation this transport serves: the tool words itself differently. */
    kind: 'pty',
    /** Other wiring may need to know which provider created the shells. */
    provider,

    list(sessionId) {
      return [...bucket(sessionId).values()].map((record) => publicInfo(record))
    },

    async create(agent, request, signal) {
      const sessionId = String(agent?.id ?? '')
      const map = bucket(sessionId)
      const id = String(request.id)
      const existing = map.get(id)
      if (existing !== undefined) return publicInfo(existing)
      if (closedIds.has(`${sessionId}:${id}`)) throw new Error(CLOSED_MESSAGE)
      const { executable, args, workdir } = await launcher(agent, signal)
      let handle
      try {
        handle = await provider.spawnTerminal({
          argv: [executable, ...args],
          cwd: process.cwd(),
          cols: request.cols ?? DEFAULT_COLS,
          rows: request.rows ?? DEFAULT_ROWS,
          terminalType: 'xterm-256color',
          env: { WSL_UTF8: '1', DSH_SESSION_ID: sessionId },
          shellActivity: true,
          graceMs: CLOSE_GRACE_MS,
          signal,
        })
      } catch (error) {
        throw new Error(`could not open a shell: ${String(error?.message ?? error)}`)
      }
      const record = {
        handle,
        // The same shape the browser controller publishes, so the tool's renderers,
        // header and readiness logic need no knowledge of where the shell came from.
        info: {
          id,
          title: 'WSL',
          shell: { name: 'WSL', path: executable, args },
          cwd: workdir,
          cols: request.cols ?? DEFAULT_COLS,
          rows: request.rows ?? DEFAULT_ROWS,
          state: 'running',
          exitCode: null,
        },
        buffer: '',
        chunks: [],
        ended: false,
        waiters: new Set(),
        decoder: new TextDecoder('utf-8'),
      }
      map.set(id, record)
      pump(record)
      return publicInfo(record)
    },

    follow(agent, id, _attachmentId, signal) {
      const sessionId = String(agent?.id ?? '')
      const record = expect(sessionId, id)
      return followStream(record, signal)
    },

    async write(agent, id, _attachmentId, data) {
      const sessionId = String(agent?.id ?? '')
      const record = expect(sessionId, id)
      if (record.ended) throw new Error(`Terminal ${String(id)} has exited`)
      record.handle.write(String(data))
    },

    async close(agent, id) {
      const sessionId = String(agent?.id ?? '')
      const map = bucket(sessionId)
      const record = map.get(String(id))
      closedIds.add(`${sessionId}:${String(id)}`)
      map.delete(String(id))
      if (record === undefined) return
      try {
        await record.handle.terminate()
      } catch {
        // A provider that already lost the process is the outcome that was wanted.
      }
    },
  }
}

/**
 * Pick the terminal transport this host offers.
 *
 * Preference order: a controller that still speaks `follow`/`write` (0.2.0 — browser terminals,
 * which the user can watch), then a self-owned PTY (0.2.1 — invisible to the sidebar). A
 * controller without `follow` is returned as-is so the tool can explain the mismatch instead of
 * failing with `controller.follow is not a function`.
 *
 * @returns the transport, or null when neither is available.
 */
export function createTerminalTransport({ ctx, config }) {
  let controller = null
  try {
    controller = typeof ctx?.get === 'function' ? ctx.get('terminalController') : null
  } catch {
    controller = null
  }
  if (controller !== null && controller !== undefined && typeof controller.follow === 'function') return controller
  let pty = null
  try {
    pty = createPtyTransport({ ctx, config })
  } catch {
    // Picking a transport must never be what stops the plugin from mounting: the other five
    // tools have nothing to do with the terminal.
    pty = null
  }
  if (pty !== null) return pty
  return controller ?? null
}
