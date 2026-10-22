/**
 * The WSL channel: a small loopback HTTP server the `dsh` command inside WSL talks to.
 *
 * Why a server of its own instead of the plugin's `webServer` routes: that server binds
 * 127.0.0.1, and under WSL2 NAT the WSL side reaches this machine through the WSL virtual
 * adapter's address, not through loopback. So this module listens on the address WSL
 * itself uses as its default gateway (discovered by asking `wsl.exe`), on a random port,
 * and every request must carry a token that only the state file and this module know.
 * The token defends the channel when the adapter is reachable from more than one peer.
 *
 * The wire protocol is line-oriented TEXT, not JSON, because the client is a bash script:
 *
 *   client -> server   POST /say     raw UTF-8 prompt in the body
 *                      POST /list    (empty body)
 *                      POST /new     one session id
 *                      POST /rm      one session id
 *                      GET  /state   (no body)
 *   server -> client   one line per frame:
 *                      `~ack`                 request accepted
 *                      `~r <ms>`              this turn's reasoning has started (ms since send)
 *                      `~t <ms>`              visible answer text has started
 *                      `~step <turn> <step>`  one step began
 *                      `~s <base64>`          reasoning chunk (raw text, UTF-8)
 *                      `~a <base64>`          answer chunk (raw text, UTF-8)
 *                      `~p`                   heartbeat, ignore
 *                      `~e <ok> <ms> <steps> <in> <out> <base64 reason>`
 *                      `~x <base64 message>`  error before/after the turn
 *                      `ok\t<id>` / `err\t<message>` for the management routes
 *
 * Base64 is what keeps arbitrary model output (newlines, tabs, ANSI, CJK) from colliding
 * with the frame markers while still streaming chunk by chunk.
 *
 * Everything here is defensive: this feature must never be the reason the plugin fails to
 * mount, so services are looked up lazily and every failure becomes a frame or an error
 * line, not an exception in `apply()`.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Size cap for a management request body (a session id), in bytes. */
const MAX_ID_BODY = 4096
/** Size cap for a prompt body, in bytes. The model gets the text verbatim. */
const MAX_PROMPT_BODY = 256 * 1024
/** Heartbeat cadence while a turn runs, so a proxy cannot idle the stream out. */
const HEARTBEAT_MS = 15000
/** Hard ceiling for one turn; the agent itself has no wall clock. */
const MAX_TURN_MS = 4 * 60 * 60 * 1000

/**
 * The channel's own state file. The `dsh` shim reads port and token from here, so it has
 * to live on the Windows side where WSL can reach it under /mnt/c.
 * @param {NodeJS.ProcessEnv} env - used only to find the user's profile directory.
 * @returns {string} absolute path to `channel.json`.
 */
export function channelStateFile(env = process.env) {
  const home = env.USERPROFILE || homedir()
  return join(home, '.dsh', 'dsh-wsl', 'channel.json')
}

/**
 * The configured default session, with the documented fallback.
 * @param {object} config - the resolved plugin config.
 * @returns {string} a non-empty session id.
 */
export function channelSessionOf(config) {
  const value = config !== null && typeof config === 'object' ? config.channelSession : undefined
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return 'wsl'
}

/** One base64 chunk frame line. @param {string} tag - `s` or `a`. @param {string} text - raw chunk. */
const chunkLine = (tag, text) => `~${tag} ${Buffer.from(text, 'utf8').toString('base64')}`

/** One base64 error frame line. @param {string} message - human readable. */
const errorLine = (message) => `~x ${Buffer.from(String(message), 'utf8').toString('base64')}`

/**
 * Read a request body with a cap, as UTF-8 text.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {number} limit - byte cap; exceeding it rejects rather than truncating.
 * @returns {Promise<string>} the body.
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error(`request body exceeds ${String(limit)} bytes`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Answer one plain-text management request.
 * @param {import('node:http').ServerResponse} response - response.
 * @param {number} code - HTTP status.
 * @param {string} line - the single line to send.
 */
function answerLine(response, code, line) {
  if (response.headersSent) {
    try { response.end() } catch { /* already gone */ }
    return
  }
  response.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(line + '\n')
}

/**
 * Pull a session's stable id out of whatever record shape the DSH build hands back.
 * Session records have carried the id on the record, in `session.id`, and in
 * `header.id` across the 0.1.7–0.2.1 line, so all three are accepted.
 * @param {unknown} record - one session record.
 * @returns {{ id: string, cwd: string|undefined, createdAt: number|undefined }} normalized.
 */
export function sessionRecordOf(record) {
  const source = record !== null && typeof record === 'object' ? record : {}
  const header = source.header ?? source.session?.header ?? source.session ?? source
  const id = header?.id ?? source.id ?? source.sessionId
  return {
    id: id === undefined || id === null ? '' : String(id),
    cwd: typeof header?.cwd === 'string' ? header.cwd : (typeof source.cwd === 'string' ? source.cwd : undefined),
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    // Forked and subagent sessions share the store but never belong in a picker of
    // conversations; the header is the only place that says so.
    parentSession: header?.parentSession ?? source.parentSession,
    origin: header?.origin ?? source.origin,
  }
}

/**
 * Normalize whatever a title lookup returns into an id -> title map.
 *
 * `sessionQuery.readTitleSnapshots` answers with one PromiseSettledResult per id
 * (`{status:'fulfilled', value:{session,title}}`), which is why the first version of
 * this picker labelled every row 未命名: it only understood plain `{id,title}` arrays.
 * Maps, plain arrays and id-keyed objects are still accepted for older builds.
 * @param {unknown} value - the service's answer.
 * @returns {Map<string, string>} titles keyed by session id.
 */
export function titlesOf(value) {
  const titles = new Map()
  const add = (id, title) => {
    if (id !== undefined && id !== null && typeof title === 'string' && title !== '') titles.set(String(id), title)
  }
  if (value instanceof Map) {
    for (const [id, entry] of value) add(id, typeof entry === 'string' ? entry : (entry?.title ?? entry?.value?.title))
    return titles
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === null || entry === undefined) continue
      if (entry.status !== undefined) {
        if (entry.status !== 'fulfilled') continue
        // `projectMany` answers `{sessionId, status, value:{session,title?}}`: the id sits
        // on the wrapper, which is the field the first version missed.
        const settled = entry.value
        add(entry.sessionId ?? settled?.session?.id ?? settled?.id, settled?.title ?? settled?.snapshot?.title)
        continue
      }
      add(entry.id ?? entry.sessionId ?? entry.session?.id ?? entry.header?.id,
        typeof entry === 'string' ? entry : (entry.title ?? entry.snapshot?.title))
    }
    return titles
  }
  if (value !== null && typeof value === 'object') {
    for (const [id, entry] of Object.entries(value)) add(id, typeof entry === 'string' ? entry : entry?.title)
  }
  return titles
}

/**
 * Create the WSL channel for one plugin mount.
 *
 * @param {object} options - wiring.
 * @param {object} options.ctx - host context (services are looked up lazily through `get`).
 * @param {object} options.config - resolved plugin config.
 * @param {(argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} [options.wsl]
 *   runs `wsl.exe` with argv, used to discover the host address WSL reaches and to install
 *   the shim. Absent in tests, where the channel binds loopback and reports that.
 * @param {NodeJS.ProcessEnv} [options.env] - environment (profile directory).
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @returns {object} the channel handle.
 */
export function createChannel({ ctx, config, wsl = undefined, env = process.env, now = Date.now } = {}) {
  const token = randomBytes(32).toString('hex')
  const stateFile = channelStateFile(env)
  /** @type {import('node:http').Server | null} */
  let server = null
  let port = 0
  let host = '127.0.0.1'
  let startedAt = null
  let stopped = false
  const inflight = new Set()

  const enabled = () => config?.channelEnabled === true
  const sessionId = () => channelSessionOf(config)

  /** Look a host service up without ever throwing. */
  const service = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /** Read one session's assistant text out of an `assistant/message` event. */
  const assistantTextOf = (event) => {
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) return ''
    let text = ''
    for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    return text
  }

  /** Write the state file the `dsh` shim reads. Best effort: a read-only profile is not fatal. */
  const publishState = () => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify({
        version: 2,
        port,
        token,
        host,
        enabled: enabled(),
        sessionId: sessionId(),
        startedAt,
      }, null, 2) + '\n', 'utf8')
    } catch {
      /* the shim reports "run DSH first" on its own */
    }
  }

  /** Remove the state file on a clean unmount, so a dead port is not advertised. */
  const unpublishState = () => {
    try { rmSync(stateFile, { force: true }) } catch { /* ignore */ }
  }

  /**
   * The address WSL uses for this machine: its default gateway. Under WSL2 NAT that is the
   * host's WSL adapter, which is exactly where this server should listen.
   * @returns {Promise<string|null>} the address, or null when WSL cannot be asked.
   */
  const discoverHostAddress = async () => {
    if (typeof wsl !== 'function') return null
    try {
      const result = await wsl(['-e', 'sh', '-c', "ip -4 route show default 2>/dev/null | awk '{print $3; exit}'"])
      const address = String(result?.stdout ?? '').trim()
      return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) ? address : null
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------- say (the turn)

  /**
   * Run one prompt through the client's own session controller and stream the turn.
   * @param {import('node:http').IncomingMessage} request - the client request.
   * @param {import('node:http').ServerResponse} response - the streaming response.
   * @param {string} prompt - the user text.
   */
  async function say(request, response, prompt) {
    if (enabled() === false) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const text = prompt.trim()
    if (text === '') return answerLine(response, 400, 'err\tempty prompt')
    const controller = service('sessionController')
    const headerSession = String(request.headers['x-dsh-wsl-session'] ?? '').trim()
    const target = headerSession !== '' ? headerSession : sessionId()
    if (controller === undefined || typeof controller.prompt !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose sessionController.prompt')
    }

    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    })
    const t0 = now()
    const requestId = randomUUID()
    const abort = new AbortController()
    let finished = false
    let steps = 0
    let reasonStarted = false
    let textStarted = false
    let answer = ''
    let usage = { inputTokens: 0, outputTokens: 0 }
    let heartbeat = null
    let offFrames = null
    let offEvents = null

    const write = (line) => {
      if (finished) return
      try { response.write(line + '\n') } catch { /* client went away */ }
    }
    const finish = (ok, reason) => {
      if (finished) return
      finished = true
      if (heartbeat !== null) clearInterval(heartbeat)
      try { offFrames?.() } catch { /* ignore */ }
      try { offEvents?.() } catch { /* ignore */ }
      // The final frame bypasses `write`: that helper refuses to write once the turn is
      // marked finished, and this is the one line that must still go out.
      try {
        response.write(`~e ${ok ? '1' : '0'} ${now() - t0} ${steps} ${usage.inputTokens} ${usage.outputTokens} ${Buffer.from(String(reason), 'utf8').toString('base64')}\n`)
      } catch { /* client went away */ }
      try { response.end() } catch { /* ignore */ }
    }

    write('~ack')
    heartbeat = setInterval(() => write('~p'), HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()

    // Frame feed: the provider's live assistant stream, the same source the GUI paints.
    offFrames = ctx?.on?.('agent/assistant-stream', ({ agent, frame }) => {
      if (finished) return
      if (agent?.session?.id !== target || frame === undefined || frame === null) return
      if (frame.type === 'start') return
      if (frame.type === 'end') return
      const chunk = frame.chunk
      if (chunk === undefined || chunk === null) return
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        if (!reasonStarted) {
          reasonStarted = true
          write(`~r ${now() - t0}`)
        }
        write(chunkLine('s', chunk.text))
        return
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        if (!textStarted) {
          textStarted = true
          write(`~t ${now() - t0}`)
        }
        write(chunkLine('a', chunk.text))
        return
      }
      if (chunk.type === 'usage' && typeof chunk.usage === 'object' && chunk.usage !== null) {
        usage = {
          inputTokens: Number(chunk.usage.inputTokens ?? usage.inputTokens) || 0,
          outputTokens: Number(chunk.usage.outputTokens ?? usage.outputTokens) || 0,
        }
      }
    }, { global: true })

    // Durable event feed: step boundaries and the turn's end are only reliable here.
    offEvents = ctx?.on?.('session/event', (session, event) => {
      if (finished) return
      if (session?.id !== target || event === undefined || event === null) return
      if (event.type === 'step/start') {
        steps += 1
        write(`~step ${String(event.data?.turn ?? '?')} ${String(event.data?.step ?? '?')}`)
        return
      }
      if (event.type === 'assistant/message') {
        const text = assistantTextOf(event)
        if (text !== '') answer = text
        const eventUsage = event.data?.usage
        if (eventUsage !== undefined && eventUsage !== null) {
          usage = {
            inputTokens: Number(eventUsage.inputTokens ?? usage.inputTokens) || 0,
            outputTokens: Number(eventUsage.outputTokens ?? usage.outputTokens) || 0,
          }
        }
        return
      }
      if (event.type === 'turn/end') {
        finish(true, event.data?.reason?.kind ?? 'completed')
      }
    })

    const onClose = () => {
      // The terminal stopped waiting (Ctrl+C). The turn keeps running in the client's
      // conversation on purpose: the user can watch it there.
      if (!finished) abort.abort()
      finished = true
      if (heartbeat !== null) clearInterval(heartbeat)
      try { offFrames?.() } catch { /* ignore */ }
      try { offEvents?.() } catch { /* ignore */ }
    }
    request.on('close', onClose)
    const deadline = setTimeout(() => {
      if (finished) return
      write(errorLine('turn exceeded the channel ceiling'))
      finish(false, 'timeout')
    }, MAX_TURN_MS)
    if (typeof deadline.unref === 'function') deadline.unref()

    try {
      // The exact admission path the browser uses: it resumes the Session when it is cold,
      // validates attachments, and records the message with the user-rpc source.
      await controller.prompt({
        sessionId: target,
        content: [{ type: 'text', text }],
        requestId,
      }, abort.signal)
    } catch (error) {
      const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
      if (!finished) {
        write(errorLine(message))
        finish(false, 'error')
      }
    }
  }

  // ------------------------------------------------------------ management routes

  /**
   * The sessions the panel's picker offers and the CLI's `list` prints: only real
   * conversations — top-level, not archived, titled — newest first, capped at 12, with
   * the configured session marked. Subagent sessions and other workspaces' untitled
   * sessions (the IM inbox, for one) share the store but are noise in this list.
   * @returns {Promise<Array<{ id: string, title: string, cwd: string, workspace: string, createdAt: number|null, current: boolean }>>} rows.
   */
  async function sessionRows() {
    const query = service('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') return []
    const records = (await query.listSessions(undefined))
      .map(sessionRecordOf)
      .filter((record) => record.id !== '')
    // Titles are folded from each session's log, so only the newest slice is read: the
    // store also holds other workspaces and old sessions nobody will pick here.
    const recent = records.slice(0, 40)
    let titles = new Map()
    try {
      if (typeof query.readTitleSnapshots === 'function') {
        titles = titlesOf(await query.readTitleSnapshots(recent.map((record) => record.id), undefined))
      }
    } catch {
      titles = new Map()
    }
    const registry = service('workspaceRegistry')
    let archived = new Set()
    const workspaceOf = new Map()
    try {
      const ids = registry?.archivedSessionIds
      archived = new Set((Array.isArray(ids) ? ids : []).map(String))
      const workspaces = typeof registry?.list === 'function' ? registry.list() : []
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        const label = typeof workspace?.title === 'string' && workspace.title !== ''
          ? workspace.title
          : (typeof workspace?.path === 'string' ? workspace.path : '')
        for (const id of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) workspaceOf.set(String(id), label)
      }
    } catch {
      archived = new Set()
    }
    const current = sessionId()
    const rows = []
    for (const record of recent) {
      if (record.parentSession !== undefined && record.parentSession !== null) continue
      if (record.origin === 'subagent') continue
      if (archived.has(record.id)) continue
      const title = titles.get(record.id) ?? ''
      if (title === '') continue
      rows.push({
        id: record.id,
        title,
        cwd: record.cwd ?? '',
        workspace: workspaceOf.get(record.id) ?? '',
        createdAt: record.createdAt ?? null,
        current: record.id === current,
      })
      if (rows.length >= 12) break
    }
    // The configured session must be visible even when it is brand new (no title yet) —
    // but only when it actually exists. A phantom row for a typo would make `dsh` fail
    // with "session not found" after the panel had just presented it as a choice.
    if (!rows.some((row) => row.current) && current !== '' && records.some((record) => record.id === current)) {
      rows.unshift({ id: current, title: '(当前会话，尚无标题)', cwd: '', workspace: workspaceOf.get(current) ?? '', createdAt: null, current: true })
    }
    return rows
  }

  /** List sessions, newest first, as tab-separated lines. */
  async function list(request, response) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const query = service('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose sessionQuery.listSessions')
    }
    const rows = (await sessionRows()).map((row) => [
      row.id,
      row.title,
      row.cwd,
      String(row.createdAt ?? ''),
      row.current ? '*' : '',
    ].join('\t'))
    return answerLine(response, 200, rows.length === 0 ? 'ok\t(no sessions)' : rows.join('\n'))
  }

  /**
   * Create one ordinary session in the client's workspace — the same call the CLI's
   * `new` and the panel's picker use, so both create exactly what the client lists.
   * @param {string} [requestedId] - explicit id, or '' to let DSH mint one.
   * @returns {Promise<{ ok: boolean, sessionId?: string, detail?: string }>} outcome.
   */
  async function createSession(requestedId = '') {
    const controller = service('sessionController')
    if (controller === undefined || typeof controller.create !== 'function') {
      return { ok: false, detail: 'this DSH build does not expose sessionController.create' }
    }
    const requested = typeof requestedId === 'string' ? requestedId.trim() : ''
    let cwd
    try {
      const query = service('sessionQuery')
      const records = typeof query?.listSessions === 'function' ? (await query.listSessions(undefined)).map(sessionRecordOf) : []
      cwd = records[0]?.cwd
    } catch {
      cwd = undefined
    }
    const created = await controller.create({
      ...(requested === '' ? {} : { sessionId: requested }),
      ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    })
    const id = created?.sessionId ?? created?.agent?.id ?? requested
    return { ok: true, sessionId: id === undefined || id === null ? '' : String(id) }
  }

  /** Create one ordinary session in the client's workspace, optionally with a chosen id. */
  async function create(request, response, body) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const result = await createSession(body)
    if (result.ok !== true) return answerLine(response, 501, `err\t${result.detail ?? 'could not create a session'}`)
    return answerLine(response, 200, `ok\t${result.sessionId ?? '(unknown)'}`)
  }

  /** Archive one session (the client's own "remove" semantics: reversible). */
  async function archive(request, response, body) {
    if (!enabled()) return answerLine(response, 409, 'err\tWSL channel is disabled in the dsh-wsl panel')
    const target = body.trim()
    if (target === '') return answerLine(response, 400, 'err\tsession id required')
    const agents = service('agents')
    try {
      if (typeof agents?.get === 'function' && agents.get(target) !== undefined) {
        return answerLine(response, 409, `err\tsession "${target}" is open in DSH; close it first`)
      }
    } catch { /* treat as closed */ }
    const workspace = service('workspaceController')
    if (workspace === undefined || typeof workspace.archiveSession !== 'function') {
      return answerLine(response, 501, 'err\tthis DSH build does not expose workspaceController.archiveSession')
    }
    await workspace.archiveSession({ sessionId: target })
    return answerLine(response, 200, `ok\t${target}`)
  }

  /** One `key=value` line per fact, for `dsh status`. */
  function state(request, response) {
    const lines = [
      `enabled=${enabled() ? '1' : '0'}`,
      `session=${sessionId()}`,
      `port=${String(port)}`,
      `version=${readVersion()}`,
      `started=${String(startedAt ?? '')}`,
    ]
    return answerLine(response, 200, lines.join('\n'))
  }

  /** The plugin's own version, read from its manifest; null when unreadable. */
  function readVersion() {
    try {
      const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      return typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  // ------------------------------------------------------------------ dispatcher

  /**
   * Dispatch one channel request.
   * @param {import('node:http').IncomingMessage} request - request.
   * @param {import('node:http').ServerResponse} response - response.
   * @returns {Promise<void>} settles when the response is done or streaming ended.
   */
  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://channel.invalid')
    const route = url.pathname
    if (route === '/state') {
      if (request.method !== 'GET') return answerLine(response, 405, 'err\tGET only')
      return state(request, response)
    }
    if (request.method !== 'POST') return answerLine(response, 405, 'err\tPOST only')
    // Every mutating route authenticates. The comparison is length-checked, then exact.
    const offered = String(request.headers['x-dsh-wsl-token'] ?? '')
    if (offered.length !== token.length || !timingSafeEqual(offered, token)) {
      return answerLine(response, 401, 'err\tmissing or wrong channel token')
    }
    if (route === '/say') return say(request, response, await readBody(request, MAX_PROMPT_BODY))
    if (route === '/list') return list(request, response)
    if (route === '/new') return create(request, response, await readBody(request, MAX_ID_BODY))
    if (route === '/rm') return archive(request, response, await readBody(request, MAX_ID_BODY))
    return answerLine(response, 404, 'err\tunknown channel route')
  }

  /** Constant-time comparison for equal-length ASCII tokens. */
  function timingSafeEqual(a, b) {
    let diff = 0
    for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
    return diff === 0
  }

  // --------------------------------------------------------------- lifecycle

  /** Bind the channel server. Failures are reported, never thrown out of `apply()`. */
  async function start() {
    if (server !== null || stopped) return { port, host }
    try {
      const discovered = await discoverHostAddress()
      server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          const message = error !== null && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
          answerLine(response, 500, `err\t${message}`)
        })
      })
      server.on('clientError', (error, socket) => {
        try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* ignore */ }
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, discovered ?? '0.0.0.0', () => {
          server.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
      host = discovered ?? '0.0.0.0'
      startedAt = now()
      publishState()
      return { port, host }
    } catch (error) {
      // A bind failure disables the channel without touching the rest of the plugin.
      server = null
      port = 0
      try { console.warn('dsh-wsl-tool: the WSL channel server did not start', error) } catch { /* ignore */ }
      return { port: 0, host: null }
    }
  }

  /** Stop the server and stop advertising it. */
  async function stop() {
    stopped = true
    unpublishState()
    if (server === null) return
    const closing = server
    server = null
    await new Promise((resolve) => closing.close(() => resolve()))
  }

  /**
   * Reflect a live settings change: the channel advertises `enabled`/`sessionId` in the
   * state file, so a switch flip has to rewrite it. Starts the server if the first
   * attempt failed (a distro that was not running yet).
   * @returns {Promise<{ port: number, host: string|null }>} the current binding.
   */
  async function refresh() {
    if (startedAt === null) {
      // Nothing is served while the channel is off; leaving the state file behind would
      // advertise a dead port, so it is removed instead.
      if (!enabled()) {
        unpublishState()
        return { port: 0, host: null }
      }
      return start()
    }
    publishState()
    return { port, host }
  }

  /** Translate one Windows absolute path to the /mnt/<drive>/ form WSL sees. */
  const toWslPath = (path) => path
    .replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${String(drive).toLowerCase()}/`)
    .replace(/\\/g, '/')

  /**
   * Install (or refresh) the `dsh` shim inside WSL and rewrite the state file.
   * @param {(path: string, contents: string, mode?: number) => void} [writer] - test seam.
   * @returns {Promise<{ ok: boolean, target?: string, detail: string }>} outcome.
   */
  async function install(writer = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  }) {
    if (typeof wsl !== 'function') return { ok: false, detail: 'no wsl.exe runner in this host' }
    // The shim reads port and token from the state file, so the server has to exist.
    if (startedAt === null) await start()
    let template
    try {
      template = readFileSync(new URL('../extras/dsh.sh', import.meta.url), 'utf8')
    } catch (error) {
      return { ok: false, detail: `could not read the shim template: ${String(error?.message ?? error)}` }
    }
    const windowsPath = join(dirname(stateFile), 'dsh.sh')
    const scriptPath = toWslPath(windowsPath)
    const configPath = toWslPath(stateFile)
    const script = template.split('__CHANNEL_CONFIG__').join(configPath)
    try {
      writer(windowsPath, script)
    } catch (error) {
      return { ok: false, detail: `could not write ${windowsPath}: ${String(error?.message ?? error)}` }
    }
    const command = [
      'set -e',
      'mkdir -p "$HOME/.local/bin" "$HOME/.config/dsh-wsl"',
      `install -m 0755 ${scriptPath} "$HOME/.local/bin/dsh"`,
      'printf "%s\\n" "$HOME/.local/bin/dsh"',
    ].join(' && ')
    try {
      const result = await wsl(['-e', 'bash', '-lc', command])
      if (result?.code !== 0) {
        return { ok: false, detail: String(result?.stderr ?? 'the install command failed').trim() }
      }
      publishState()
      const output = String(result?.stdout ?? '').trim().split('\n')
      return { ok: true, target: output[output.length - 1] ?? '~/.local/bin/dsh', detail: 'installed' }
    } catch (error) {
      return { ok: false, detail: String(error?.message ?? error) }
    }
  }

  /** Facts for the panel: what the channel is and whether the shim is there. */
  async function panelState() {
    let shim = { installed: false, path: '' }
    if (typeof wsl === 'function') {
      try {
        const result = await wsl(['-e', 'bash', '-lc', 'test -x "$HOME/.local/bin/dsh" && echo yes || echo no'])
        const installed = String(result?.stdout ?? '').trim() === 'yes'
        shim = { installed, path: '~/.local/bin/dsh' }
      } catch { /* reported as not installed */ }
    }
    let sessions = []
    try {
      sessions = await sessionRows()
    } catch {
      sessions = []
    }
    return {
      enabled: enabled(),
      sessionId: sessionId(),
      sessions,
      port,
      host,
      version: readVersion(),
      stateFile,
      shim,
    }
  }

  return { start, stop, refresh, say, list, create, createSession, archive, install, panelState, state, handle, token, get port() { return port }, get host() { return host }, stateFile }
}
