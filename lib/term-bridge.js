// The browser bridge: a terminal transport for DSH 0.2.1+ that drives the user's OWN
// sidebar terminal through the browser half of this plugin.
//
// DSH 0.2.1 removed `terminalController.follow`/`write` from the host plane and replaced the
// pair with `attach`, whose input uplink comes from the CALLER's Remote invocation — something
// a host-side plugin cannot supply. `lib/pty-transport.js` answered that by owning a private
// PTY, which works but is invisible to the user. This module restores the collaboration the
// tool is really about: the CLIENT half (running in the page, where Remote calls are legal)
// attaches to the sidebar terminal, and this host half tells it what to type and reads back
// what the terminal shows.
//
// The channel is plain same-origin HTTP, because that is all the two halves share without a
// new transport dependency:
//
//   page ── POST /poll   (long poll; marks the window alive) ──▶ commands
//   page ── POST /events (results, screen snapshots, output)  ──▶ host queues
//
// One attachment is one tool call: it takes the input control (the user's tab becomes
// read-only, exactly like the old `follow`), streams the screen and output back, and is
// detached in the tool's own `finally` so the keyboard comes back. The process itself is never
// closed here unless the caller named it — `detach` only releases the attachment.
//
// Everything is defensive: any window may be closed, reloaded, or replaced by a second one, and
// none of that may hang a tool call or take the other five tools down. A window that stops
// answering fails the attachment with one readable sentence, and the tool reports it.

import { answerJson, isJsonRequest, readJsonBody } from './http.js'

/** Where the page polls for work and reports what it saw. */
const POLL_ROUTE = '/dsh-wsl-tool/term-bridge/poll'
const EVENTS_ROUTE = '/dsh-wsl-tool/term-bridge/events'

/**
 * The bridge's own deadlines.
 *
 * Exported-through-a-parameter rather than hard-coded so the host suite can drive the timeout
 * paths without waiting out a real fifteen seconds; production always uses these values.
 */
const DEFAULT_TIMINGS = {
  /** How long one poll may stay open with nothing to deliver. */
  pollHoldMs: 10_000,
  /** A window that has not polled for this long is treated as gone. */
  clientTtlMs: 15_000,
  /** How long an `attach` may take to produce its first screen snapshot. */
  attachTimeoutMs: 15_000,
  /** How long a `write` may stay unacknowledged before the tool call is told. */
  writeTimeoutMs: 20_000,
  /** How often a live attachment checks that its window is still there. */
  lostCheckMs: 2_000,
}
/** Bodies: a poll is tiny; an events batch may carry a screen and a burst of output. */
const MAX_POLL_BODY = 64 * 1024
const MAX_EVENTS_BODY = 4 * 1024 * 1024

/**
 * The browser half's side of one tool call.
 *
 * Frames are pushed by the events route and pulled by the tool's frame loop; `next` has the same
 * shape the old `follow` iterator had, so `wsl-term` needs no new loop. A failure is reported
 * through the same channel the frames use: the next pull throws, and the tool's existing error
 * wording applies.
 *
 * @param {{ id: string, sessionId: string, terminalId: string, isAlive: () => boolean, timing: typeof DEFAULT_TIMINGS }} spec
 * @returns the attachment record with `push`/`fail`/`finish`/`next`/`dispose`.
 */
function createAttachment({ id, sessionId, terminalId, isAlive, timing }) {
  const frames = []
  const waiters = new Set()
  /** @type {Map<string, { resolve: () => void, reject: (error: Error) => void, timer: any }>} */
  const writes = new Map()
  let ended = false
  let failure = null
  let sawFrame = false
  let attachTimer = null
  let lostTimer = null

  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }

  const clearTimers = () => {
    if (attachTimer !== null) clearTimeout(attachTimer)
    if (lostTimer !== null) clearInterval(lostTimer)
    attachTimer = null
    lostTimer = null
  }

  const attachment = {
    id,
    sessionId,
    terminalId,
    writes,
    get ended() {
      return ended
    },
    /** A frame from the page: the first one proves the attachment is live. */
    push(frame) {
      if (ended) return
      if (!sawFrame) {
        sawFrame = true
        if (attachTimer !== null) clearTimeout(attachTimer)
        attachTimer = null
      }
      frames.push(frame)
      wake()
    },
    /** A failure from the page, from the bridge itself, or from a lost window. */
    fail(error) {
      if (ended) return
      ended = true
      failure = error instanceof Error ? error : new Error(String(error))
      clearTimers()
      for (const write of writes.values()) {
        clearTimeout(write.timer)
        write.reject(failure)
      }
      writes.clear()
      wake()
    },
    /** The attachment was ended on purpose (the tool call finished). */
    finish() {
      if (ended) return
      ended = true
      clearTimers()
      wake()
    },
    /**
     * Pull one frame, or null when the attachment ended.
     * @param signal - the tool's detach signal.
     */
    async next(signal) {
      while (true) {
        if (frames.length > 0) return frames.shift()
        if (failure !== null) throw failure
        if (ended || signal?.aborted === true) return null
        await new Promise((resolve) => {
          const wakeOnce = () => {
            waiters.delete(wakeOnce)
            signal?.removeEventListener?.('abort', wakeOnce)
            resolve()
          }
          waiters.add(wakeOnce)
          signal?.addEventListener?.('abort', wakeOnce, { once: true })
        })
      }
    },
    /** Stop on purpose and clear every timer this attachment owns. */
    dispose() {
      clearTimers()
      ended = true
      wake()
    },
  }

  // A window that never answers must not hold the tool call for its whole deadline: the tool
  // reports "nothing was typed" otherwise, which is true but hides the reason.
  attachTimer = setTimeout(() => {
    attachment.fail(new Error(
      `the DSH window did not attach to terminal ${terminalId} within ${timing.attachTimeoutMs} ms — `
      + 'open the DSH window (or the terminal tab) and retry',
    ))
  }, timing.attachTimeoutMs)
  if (typeof attachTimer.unref === 'function') attachTimer.unref()
  // The page can close without saying goodbye. The poll heartbeat is the only evidence it is
  // still there, and a lost window must fail the call instead of leaving the keyboard taken.
  lostTimer = setInterval(() => {
    if (!attachment.ended && !isAlive()) {
      attachment.fail(new Error('the DSH window stopped answering the terminal bridge — the tool released the terminal'))
    }
  }, timing.lostCheckMs)
  if (typeof lostTimer.unref === 'function') lostTimer.unref()

  return attachment
}

/**
 * Build the bridge transport on top of a 0.2.1 terminal controller.
 *
 * The returned object has the same shape as the PTY transport (`kind`, `list`, `create`,
 * `follow`, `write`, `close`) so `wsl-term` needs no branch of its own. When no window is
 * polling, every method delegates to the PTY transport, which is why the tool keeps working
 * (invisibly) when the page is closed, and why choosing the bridge can never make the terminal
 * unusable on its own.
 *
 * @param {{ ctx: object, config: object, controller: object | null, pty: object | null, timings?: object }} options
 * @returns the transport, or null when the host has no controller to drive.
 */
export function createBridgeTransport({ ctx, config, controller, pty, timings }) {
  if (controller === null || controller === undefined) return null
  if (typeof controller.list !== 'function' || typeof controller.create !== 'function'
    || typeof controller.close !== 'function') return null

  /** The deadlines this instance runs on; the suite overrides them to test the timeout paths. */
  const timing = { ...DEFAULT_TIMINGS, ...(timings ?? {}) }

  /** The window currently served; a new page replaces the previous one. */
  let clientId = null
  let clientSeenAt = 0
  let commandSeq = 0
  /** @type {Array<Record<string, unknown>>} */
  const commands = []
  /** The one held long poll, if any. */
  let pollWaiter = null
  /** @type {Map<string, ReturnType<typeof createAttachment>>} */
  const attachments = new Map()
  /** @type {Map<string, { kind: string, attachmentId: string, resolve?: (value?: unknown) => void, reject?: (error: Error) => void, timer?: any }>} */
  const pendingCommands = new Map()
  /** sessionId -> terminal ids this plugin opened through the host controller. Everything that
   *  is not in here belongs to the user, and a terminal the user opened is never closed by this
   *  plugin — that rule needs to survive a page reload, so it lives on the host, not the page. */
  const created = new Map()
  const createdIn = (sessionId) => {
    const key = String(sessionId ?? '')
    let bucket = created.get(key)
    if (bucket === undefined) {
      bucket = new Set()
      created.set(key, bucket)
    }
    return bucket
  }

  /** Whether a window is currently holding the bridge open. */
  const isAlive = () => clientId !== null && (Date.now() - clientSeenAt) < timing.clientTtlMs

  const answerPoll = (waiter, payload) => {
    if (waiter.timer !== null) clearTimeout(waiter.timer)
    if (pollWaiter === waiter) pollWaiter = null
    try {
      answerJson(waiter.response, 200, payload)
    } catch {
      // The page navigated away between the queue call and this answer; nothing to report.
    }
  }

  /** Hand queued commands to the window, if one is waiting. */
  const flush = () => {
    if (commands.length === 0 || pollWaiter === null) return
    if (pollWaiter.clientId !== clientId) return
    const batch = commands.splice(0, commands.length)
    answerPoll(pollWaiter, { ok: true, commands: batch, ttlMs: timing.clientTtlMs })
  }

  const newCommandId = () => String(++commandSeq)

  const queue = (command) => {
    commands.push(command)
    flush()
    return command.id
  }

  const attachmentOf = (attachmentId) => attachments.get(String(attachmentId ?? ''))

  /** One text value from the page; a route is not the place to buffer something else. */
  const textOf = (value) => (typeof value === 'string' ? value : '')

  /** Info the tool can render, falling back to what the host controller knows. */
  const infoOf = (attachment, info) => {
    if (info !== null && typeof info === 'object') return info
    try {
      const live = controller.list(attachment.sessionId)
      const found = Array.isArray(live)
        ? live.find((entry) => String(entry?.id) === String(attachment.terminalId))
        : undefined
      if (found !== undefined && found !== null) return found
    } catch {
      // A refused list is only a missing fallback; the frame keeps its own identity.
    }
    return {
      id: attachment.terminalId,
      title: '',
      shell: { name: 'shell', path: '', args: [] },
      cwd: '',
      cols: 0,
      rows: 0,
      state: 'running',
      exitCode: null,
    }
  }

  /** Fail everything the previous window owned; a window cannot inherit its attachments. */
  const releaseAttachments = (reason) => {
    for (const attachment of [...attachments.values()]) {
      attachment.fail(new Error(reason))
      attachments.delete(attachment.id)
    }
    for (const [commandId, pending] of [...pendingCommands]) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (pending.reject !== undefined) pending.reject(new Error(reason))
      pendingCommands.delete(commandId)
    }
    commands.length = 0
  }

  /**
   * Mark a window as the live one.
   *
   * A second DSH window must not fight the first one: while the serving window is alive its
   * attachments belong to it, and the newcomer is answered empty so it simply waits. Only a
   * window whose heartbeat has stopped is replaced — that is the app moving to another window,
   * and the old attachments cannot be driven any more, so they fail honestly.
   */
  const markPolling = (id) => {
    clientSeenAt = Date.now()
    if (clientId === id) return
    const previous = clientId
    clientId = id
    if (previous !== null) {
      releaseAttachments('another DSH window took over the terminal bridge')
      if (pollWaiter !== null) answerPoll(pollWaiter, { ok: true, commands: [], ttlMs: timing.clientTtlMs })
    }
  }

  /** Whether this poller is a second window that has to wait for the serving one to go. */
  const isStandby = (id) => clientId !== null && clientId !== id && isAlive()

  /** Handle one `result` event: the page's acknowledgement of a command. */
  const handleResult = (event) => {
    const commandId = String(event?.commandId ?? '')
    const pending = pendingCommands.get(commandId)
    if (pending === undefined) return
    pendingCommands.delete(commandId)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    const ok = event?.ok === true
    const message = typeof event?.error === 'string' && event.error.trim() !== ''
      ? event.error.trim()
      : 'the browser refused the command'
    if (pending.kind === 'attach') {
      if (ok) return
      const attachment = attachmentOf(pending.attachmentId)
      attachment?.fail(new Error(message))
      attachments.delete(String(pending.attachmentId))
      return
    }
    if (pending.kind === 'write') {
      if (ok) pending.resolve?.()
      else pending.reject?.(new Error(message))
    }
  }

  /** Handle one terminal frame from the page. */
  const handleFrame = (event) => {
    const attachment = attachmentOf(event?.attachmentId)
    if (attachment === undefined) return
    if (event.type === 'error') {
      attachment.fail(new Error(textOf(event.message) !== '' ? textOf(event.message) : 'the browser lost the terminal'))
      attachments.delete(attachment.id)
      return
    }
    if (event.type === 'snapshot') {
      attachment.push({
        type: 'snapshot',
        screen: textOf(event.screen),
        info: infoOf(attachment, event.info),
        writable: event.writable !== false,
      })
      return
    }
    if (event.type === 'output') {
      attachment.push({ type: 'output', data: textOf(event.data) })
      return
    }
    if (event.type === 'state') {
      attachment.push({ type: 'state', info: infoOf(attachment, event.info), writable: event.writable === true })
    }
  }

  const handleEvent = (event) => {
    if (event === null || typeof event !== 'object') return
    try {
      if (event.type === 'result') handleResult(event)
      else handleFrame(event)
    } catch (error) {
      console.warn('dsh-wsl-tool: a terminal-bridge event failed', error)
    }
  }

  // ------------------------------------------------------------------ routes

  const servePoll = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isJsonRequest(request)) {
      answerJson(response, 415, { ok: false, error: '请求必须是 application/json' })
      return
    }
    const body = await readJsonBody(request, MAX_POLL_BODY)
    if (body.error !== undefined) {
      answerJson(response, 400, { ok: false, error: body.error })
      return
    }
    const id = typeof body.value.clientId === 'string' ? body.value.clientId.trim() : ''
    if (id === '') {
      answerJson(response, 400, { ok: false, error: 'clientId 不能为空' })
      return
    }
    // A second window waits instead of stealing the bridge: it gets one empty held poll and
    // never becomes the command waiter, so the serving window keeps its attachments. The
    // heartbeat of the serving window is what decides when the role moves (see markPolling).
    if (isStandby(id)) {
      const standbyTimer = setTimeout(() => {
        answerJson(response, 200, { ok: true, commands: [], ttlMs: timing.clientTtlMs })
      }, timing.pollHoldMs)
      if (typeof standbyTimer.unref === 'function') standbyTimer.unref()
      response?.on?.('close', () => clearTimeout(standbyTimer))
      return
    }
    markPolling(id)
    if (commands.length > 0) {
      const batch = commands.splice(0, commands.length)
      answerJson(response, 200, { ok: true, commands: batch, ttlMs: timing.clientTtlMs })
      return
    }
    // One long poll at a time: the page loops, and a second outstanding poll would only race
    // the first for the same commands.
    if (pollWaiter !== null) answerPoll(pollWaiter, { ok: true, commands: [], ttlMs: timing.clientTtlMs })
    const waiter = { clientId: id, response, timer: null }
    waiter.timer = setTimeout(() => {
      answerPoll(waiter, { ok: true, commands: [], ttlMs: timing.clientTtlMs })
    }, timing.pollHoldMs)
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
    pollWaiter = waiter
    // A closed connection means the page is gone; the timer is the only thing left to clear.
    response?.on?.('close', () => {
      if (pollWaiter === waiter) {
        clearTimeout(waiter.timer)
        pollWaiter = null
      }
    })
  }

  const serveEvents = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isJsonRequest(request)) {
      answerJson(response, 415, { ok: false, error: '请求必须是 application/json' })
      return
    }
    const body = await readJsonBody(request, MAX_EVENTS_BODY)
    if (body.error !== undefined) {
      answerJson(response, 400, { ok: false, error: body.error })
      return
    }
    const id = typeof body.value.clientId === 'string' ? body.value.clientId.trim() : ''
    if (id !== clientId) {
      // A stale page (reloaded, or replaced by another window) has nothing this host wants.
      answerJson(response, 200, { ok: true })
      return
    }
    clientSeenAt = Date.now()
    const events = Array.isArray(body.value.events) ? body.value.events : []
    for (const event of events) handleEvent(event)
    answerJson(response, 200, { ok: true })
  }

  /** Publish the two routes. Optional, exactly like the panel's own routes: a host without a
   *  web server simply makes the bridge unavailable and the PTY fallback applies. */
  try {
    if (typeof ctx?.inject === 'function') {
      ctx.inject(['webServer'], (inner) => {
        try {
          const webServer = inner?.webServer
          if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
          const publish = (path, handler, label) => {
            const disposer = webServer.register({ kind: 'exact', path, handler })
            if (typeof inner.effect === 'function') inner.effect(() => disposer, label)
          }
          publish(POLL_ROUTE, (request, response) => servePoll(request, response), 'dsh-wsl-tool: terminal-bridge poll')
          publish(EVENTS_ROUTE, (request, response) => serveEvents(request, response), 'dsh-wsl-tool: terminal-bridge events')
        } catch (error) {
          console.warn('dsh-wsl-tool: the terminal bridge could not publish its routes', error)
        }
      })
    }
  } catch (error) {
    console.warn('dsh-wsl-tool: the terminal bridge could not publish its routes', error)
  }

  // A plugin unload must not leave a held poll or an attachment timer behind.
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        releaseAttachments('the terminal bridge was unloaded')
        if (pollWaiter !== null) answerPoll(pollWaiter, { ok: true, commands: [], ttlMs: timing.clientTtlMs })
      }, 'dsh-wsl-tool: terminal-bridge lifetime')
    }
  } catch {
    // A context without effects simply has no unload hook.
  }

  // --------------------------------------------------------------- transport

  /** Whether the page is alive AND this build can drive a terminal through it. */
  const bridgeLive = () => isAlive()

  /**
   * The terminals this plugin may drive on its own: its private PTY shells and the browser
   * terminals it opened through the host controller.
   *
   * A terminal the USER opened is deliberately absent. The tool's automatic choice must never
   * land in a shell the user keeps for their own long-running work — the owner asked for that
   * explicitly after the first acceptance run — and listing it would make `pickTerminal` do
   * exactly that. Such a terminal can still be driven when the caller NAMES its id (an explicit
   * request), and it is never closed by this plugin either way.
   */
  const ownedTerminals = (sessionId) => {
    const found = []
    const seen = new Set()
    const add = (info) => {
      const id = String(info?.id ?? '')
      if (id === '' || seen.has(id)) return
      seen.add(id)
      found.push(info)
    }
    if (pty !== null && typeof pty.list === 'function') {
      try {
        const listed = pty.list(sessionId)
        if (Array.isArray(listed)) for (const info of listed) add(info)
      } catch {
        // A PTY transport that cannot list has nothing to offer this call.
      }
    }
    const ids = created.get(String(sessionId ?? ''))
    if (bridgeLive() && ids !== undefined && ids.size > 0) {
      try {
        const listed = controller.list(sessionId)
        if (Array.isArray(listed)) {
          for (const info of listed) if (ids.has(String(info?.id))) add(info)
        }
      } catch {
        // The host controller refused the list; the PTY shells are still usable.
      }
    }
    return found
  }

  /** Whether a terminal id belongs to the PTY transport (a shell this plugin opened). */
  const ptyOwns = (sessionId, id) => {
    if (pty === null || typeof pty.list !== 'function') return false
    try {
      const listed = pty.list(sessionId)
      return Array.isArray(listed) && listed.some((info) => String(info?.id) === String(id))
    } catch {
      return false
    }
  }

  /** Whether this plugin opened the terminal itself (only those may be closed by it). */
  const owns = (sessionId, id) => {
    if (ptyOwns(sessionId, id)) return true
    return created.get(String(sessionId ?? ''))?.has(String(id)) === true
  }

  /** Describe one terminal by id, including a terminal the user opened (explicit use only). */
  const describe = (sessionId, id) => {
    if (pty !== null && typeof pty.list === 'function') {
      try {
        const listed = pty.list(sessionId)
        const found = Array.isArray(listed) ? listed.find((info) => String(info?.id) === String(id)) : undefined
        if (found !== undefined) return found
      } catch {
        // Fall through to the host controller.
      }
    }
    try {
      const listed = controller.list(sessionId)
      const found = Array.isArray(listed) ? listed.find((info) => String(info?.id) === String(id)) : undefined
      if (found !== undefined) return found
    } catch {
      // No description then; the caller reports the terminal as gone.
    }
    return null
  }

  const detachAttachment = (attachment) => {
    if (attachments.get(attachment.id) !== attachment) return
    attachments.delete(attachment.id)
    attachment.dispose()
    for (const [commandId, entry] of [...pendingCommands]) {
      if (entry.attachmentId !== attachment.id) continue
      pendingCommands.delete(commandId)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
    }
    // Only a live window can be told; a gone window needs nothing and a reloaded one has no
    // attachment left to release.
    if (bridgeLive()) queue({ id: newCommandId(), kind: 'detach', attachmentId: attachment.id })
  }

  const follow = (agent, id, attachmentId, signal) => {
    const sessionId = String(agent?.id ?? '')
    if (ptyOwns(sessionId, id)) return pty.follow(agent, id, attachmentId, signal)
    if (!bridgeLive()) {
      throw new Error(
        'the DSH window is not answering the terminal bridge — no page is open to drive a sidebar terminal '
        + '(open the DSH window and retry)',
      )
    }
    const attachment = createAttachment({
      id: String(attachmentId), sessionId, terminalId: String(id), isAlive, timing,
    })
    attachments.set(attachment.id, attachment)
    const commandId = newCommandId()
    pendingCommands.set(commandId, { kind: 'attach', attachmentId: attachment.id })
    queue({
      id: commandId, kind: 'attach', attachmentId: attachment.id, sessionId, terminalId: String(id),
    })

    const onAbort = () => attachment.finish()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    return (async function* bridgeFrames() {
      try {
        while (true) {
          const frame = await attachment.next(signal)
          if (frame === null) return
          yield frame
        }
      } finally {
        signal?.removeEventListener?.('abort', onAbort)
        detachAttachment(attachment)
      }
    })()
  }

  const write = async (agent, id, attachmentId, data) => {
    const attachment = attachmentOf(attachmentId)
    if (attachment === undefined) {
      const sessionId = String(agent?.id ?? '')
      if (ptyOwns(sessionId, id)) return pty.write(agent, id, attachmentId, data)
      throw new Error(`terminal ${String(id)} has no live bridge attachment`)
    }
    if (!bridgeLive()) throw new Error('the DSH window stopped answering the terminal bridge')
    const command = { id: newCommandId(), kind: 'write', attachmentId: attachment.id, data: String(data) }
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(command.id)
        reject(new Error(`the DSH window did not acknowledge the keystrokes within ${timing.writeTimeoutMs} ms`))
      }, timing.writeTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      pendingCommands.set(command.id, { kind: 'write', attachmentId: attachment.id, resolve, reject, timer })
    })
    queue(command)
    await settled
  }

  const close = async (agent, id) => {
    const sessionId = String(agent?.id ?? '')
    for (const attachment of [...attachments.values()]) {
      if (attachment.sessionId === sessionId && String(attachment.terminalId) === String(id)) {
        detachAttachment(attachment)
      }
    }
    if (ptyOwns(sessionId, id)) return pty.close(agent, id)
    return controller.close(agent, id)
  }

  /**
   * Open a terminal for the tool's own work.
   *
   * The private PTY comes first: it is the shell this plugin fully owns, it cannot collide with
   * the user's own terminals, and it is what the tool used before the bridge existed. Only a host
   * without a PTY provider falls back to a browser terminal through the host controller — and
   * that one is recorded as OURS, so it may later be closed by `subtask-done`.
   */
  const create = async (agent, request, signal) => {
    if (pty !== null) return pty.create(agent, request, signal)
    if (bridgeLive()) {
      const info = await controller.create(agent, request, signal)
      if (info !== null && info !== undefined && info.id !== undefined) createdIn(agent?.id).add(String(info.id))
      return info
    }
    throw new Error(
      'no terminal this plugin can drive: the DSH window is closed and this host has no '
      + '`subprocess` provider with `spawnTerminal`',
    )
  }

  return {
    /** The tool words itself by generation: `bridge` means a page can drive a browser terminal. */
    get kind() {
      return bridgeLive() ? 'bridge' : (pty !== null ? 'pty' : 'bridge')
    },
    /** This build CAN join a browser terminal, even if the window is closed right now. */
    bridgeCapable: true,
    provider: pty?.provider,

    /**
     * Whether this plugin opened the terminal (only those may be closed by the tool). Without a
     * live page the answer for a browser terminal is still the recorded ownership: the user's
     * terminal must never become closable just because the page went away.
     */
    owns(sessionId, id) {
      return owns(sessionId, id)
    },

    /** The per-call wording: `pty` shells are private; anything else is driven by the page. */
    kindOf(sessionId, id) {
      return ptyOwns(sessionId, id) ? 'pty' : 'bridge'
    },

    /** Describe one terminal by id (a user's terminal is included for explicit calls). */
    describe(sessionId, id) {
      return describe(sessionId, id)
    },

    /**
     * Whether a page is holding the bridge open, for the read-only `/info` route.
     *
     * Counts only — no client ids, no attachment ids, no session ids: this route is served by
     * the local web server, and the panel's 「复制插件信息」 copies it out. It answers the one
     * question a person debugging the bridge actually has: is any page polling right now?
     */
    status() {
      return {
        client: bridgeLive(),
        attachments: attachments.size,
        pending: pendingCommands.size,
      }
    },

    list(sessionId) {
      return ownedTerminals(sessionId)
    },

    async create(agent, request, signal) {
      return create(agent, request, signal)
    },

    follow(agent, id, attachmentId, signal) {
      return follow(agent, id, attachmentId, signal)
    },

    async write(agent, id, attachmentId, data) {
      return write(agent, id, attachmentId, data)
    },

    async close(agent, id) {
      return close(agent, id)
    },
  }
}
