/**
 * The log of terminal subtasks, one conversation at a time.
 *
 * A "subtask" is the unit the terminal tool works in: one shell reserved for one piece of
 * work, used for as many steps as that work needs, and then either closed or left idle so a
 * follow-up step can pick it up again — the same shape as a teammate that has finished its
 * turn but is still there to be messaged.
 *
 * This module is the bookkeeping only: the tool records, the Host route publishes, and the
 * client's dock row renders. It is deliberately free of I/O so it can be tested directly.
 *
 * Entries live for the DSH run, exactly like the terminals they describe: both are gone after
 * a restart, so a display that promised otherwise would be lying.
 */

/** How many entries one conversation keeps. Older ones are dropped in this order: finished
 *  records, then display-only records for a user's terminal, then running records that never
 *  got a shell. A running record with a live terminal is never dropped. `total` is kept
 *  separately, so the count never regresses. */
const PER_SESSION_LIMIT = 60

/**
 * @returns a registry with one log per session id.
 */
export function createSubtaskLog() {
  /** @type {Map<string, { entries: Map<string, object>, total: number, nextId: number }>} */
  const sessions = new Map()

  const bucket = (sessionId) => {
    const key = String(sessionId ?? '')
    let found = sessions.get(key)
    if (found === undefined) {
      found = { entries: new Map(), total: 0, nextId: 1 }
      sessions.set(key, found)
    }
    return found
  }

  const trim = (state) => {
    if (state.entries.size <= PER_SESSION_LIMIT) return
    const excess = () => state.entries.size - PER_SESSION_LIMIT
    const oldestFirst = (entries) => [...entries]
      .sort((left, right) => (left.finishedAt ?? left.updatedAt) - (right.finishedAt ?? right.updatedAt))
    // The limit has to hold even when nothing is ever finished (an agent that forgets
    // `subtask-done`, or the dock's records for terminals the user opened, whose liveness the
    // projection knows but this module does not). Drop in increasing cost to the user:
    //  1. finished work — nothing live is lost;
    //  2. display-only records for a user's terminal — the dock re-creates one from the
    //     terminal inventory on its next read, so a live shell is not lost either;
    //  3. running records that never got a shell (`terminalId === null`) — no bookkeeping can
    //     be attached to them, and a real run would have set an id.
    // A running record WITH a terminal id is never dropped on age alone.
    const buckets = [
      oldestFirst([...state.entries.values()].filter((entry) => entry.status === 'done')),
      oldestFirst([...state.entries.values()].filter((entry) => entry.status !== 'done' && entry.userTerminal === true)),
      oldestFirst([...state.entries.values()]
        .filter((entry) => entry.status !== 'done' && entry.userTerminal !== true && entry.terminalId === null)),
    ]
    for (const bucket of buckets) {
      while (excess() > 0 && bucket.length > 0) state.entries.delete(bucket.shift().id)
    }
  }

  return {
    /**
     * Open (or reuse) the subtask with this title, and attach a terminal to it.
     *
     * Repeated calls with the same title are the normal case: that is what "one shell for one
     * subtask" means. A title that was already finished starts a fresh entry, because the
     * earlier work is done and its record has to stay as it was.
     * @param {string} sessionId - conversation the work belongs to.
     * @param {string} title - what the work is about, in the user's language.
     * @param {{ terminalId?: string, terminalCreated?: boolean, terminalSnapshot?: object }} [terminal] - the shell used.
     * @returns the live entry.
     */
    start(sessionId, title, terminal) {
      const state = bucket(sessionId)
      const wanted = String(title ?? '').trim()
      for (const entry of state.entries.values()) {
        if (entry.title === wanted && entry.status !== 'done') {
          entry.updatedAt = Date.now()
          if (terminal?.terminalId !== undefined) {
            entry.terminalId = String(terminal.terminalId)
            // The mark describes THIS terminal, not the first one this title ever used. It is what
            // `subtask-done` reads before closing a shell, so a run that attaches a terminal the
            // tool did NOT open must CLEAR it: reusing the entry must never leave "we opened it"
            // attached to the user's own terminal, which the tool promises never to close. A caller
            // that passes no terminal (recording a command) must not touch it either.
            entry.terminalCreated = terminal.terminalCreated === true
          }
          if (terminal?.terminalSnapshot !== undefined && terminal.terminalSnapshot !== null) {
            entry.terminalSnapshot = { ...terminal.terminalSnapshot }
          }
          return entry
        }
      }
      const entry = {
        id: `${state.nextId}`,
        title: wanted,
        status: 'running',
        terminalId: terminal?.terminalId === undefined ? null : String(terminal.terminalId),
        terminalCreated: terminal?.terminalCreated === true,
        terminalKept: null,
        // The last description of this shell. The live one is preferred while the terminal
        // exists; this is what lets the detail still name the shell after it is closed.
        terminalSnapshot: terminal?.terminalSnapshot === undefined || terminal.terminalSnapshot === null
          ? null
          : { ...terminal.terminalSnapshot },
        commands: [],
        result: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        finishedAt: null,
      }
      state.nextId += 1
      state.total += 1
      state.entries.set(entry.id, entry)
      trim(state)
      return entry
    },

    /** Record one command that ran under this subtask, with its exit code when known. */
    recordCommand(sessionId, title, command, exitCode) {
      const entry = this.start(sessionId, title)
      entry.commands.push({
        command: String(command),
        exitCode: exitCode === null || exitCode === undefined ? null : Number(exitCode),
        at: Date.now(),
      })
      entry.updatedAt = Date.now()
      return entry
    },

    /**
     * Close the subtask out.
     *
     * A title that has no running entry is NOT invented here: finishing work that never
     * started would add a phantom row (and a total) to the dock. The caller reports that
     * instead; the return value is null in that case.
     * @param {boolean} terminalKept - true when its shell was left idle for possible follow-up
     *   work, false when it was closed. That decision is the caller's; this only records it.
     * @returns the finished entry, or null when no running subtask has that title.
     */
    finish(sessionId, title, { result, terminalKept } = {}) {
      const state = bucket(sessionId)
      const wanted = String(title ?? '').trim()
      const entry = [...state.entries.values()].find((candidate) => candidate.title === wanted && candidate.status !== 'done')
      if (entry === undefined) return null
      entry.status = 'done'
      entry.result = result === undefined || result === null ? null : String(result)
      entry.terminalKept = terminalKept !== false
      entry.finishedAt = Date.now()
      entry.updatedAt = Date.now()
      return entry
    },

    /**
     * Everything this conversation has, running first.
     * @returns {{ total: number, running: number, entries: object[] }}
     */
    list(sessionId) {
      const state = bucket(sessionId)
      const entries = [...state.entries.values()].sort((left, right) => {
        if ((left.status !== 'done') !== (right.status !== 'done')) return left.status === 'done' ? 1 : -1
        if (left.status !== 'done') return right.updatedAt - left.updatedAt
        return (right.finishedAt ?? 0) - (left.finishedAt ?? 0)
      })
      return {
        total: state.total,
        running: entries.filter((entry) => entry.status !== 'done').length,
        entries,
      }
    },

    /** Every session's log, for the Host route the client reads. */
    snapshot() {
      const out = {}
      for (const [sessionId, state] of sessions.entries()) out[sessionId] = this.list(sessionId)
      return out
    },
  }
}

/**
 * One subtask as the client's dock row shows it.
 *
 * The compact row needs three things and nothing more: what the work was, whether it is still
 * running, and what happened to its shell. The rest — the commands it used and the terminal's
 * full description — is the detail the user opens by clicking, so it travels in the same object
 * rather than in a second request.
 *
 * `live` is the terminal this subtask used, as the terminal service reports it right now, or
 * `null` when no terminal has that id any more. That is what keeps the row from lying: a terminal
 * that is gone — closed by `close`, by the user, or by the app rebuilding a tab — reads as
 * closed and the subtask reads as finished, whatever the log last heard.
 *
 * @param {object} entry - as stored above.
 * @param {object|null} [live] - the terminal's current description, when it still exists.
 * @returns a plain object with only the fields the client renders.
 */
export function projectSubtask(entry, live = undefined) {
  const gone = live === null
  // A shell can EXIT while its tab survives (`live.state === 'exited'`): the record must end
  // then too, or the dock keeps claiming a dead shell is in use and every `run` refuses it.
  const exited = live !== null && live !== undefined && typeof live.state === 'string'
    && live.state !== 'running'
  const finished = entry.status === 'done' || gone || exited
  const terminal = !finished
    ? 'attached'
    : gone || exited || entry.terminalKept === false
      ? 'closed'
      : 'idle'
  // The live description wins while the shell exists; after it is gone the last one seen is what
  // remains, flagged so the detail can say it is no longer current rather than pretend.
  const source = live === null || live === undefined ? (entry.terminalSnapshot ?? null) : live
  const stale = (live === null || live === undefined) && source !== null
  const info = source === null
    ? null
    : {
      id: String(source.id ?? entry.terminalId ?? ''),
      title: source.title ?? null,
      shell: source.shell?.name ?? null,
      shellPath: source.shell?.path ?? null,
      args: Array.isArray(source.shell?.args) ? source.shell.args : [],
      cwd: source.cwd ?? null,
      cols: source.cols ?? null,
      rows: source.rows ?? null,
      state: source.state ?? null,
      exitCode: source.exitCode ?? null,
      toolCreated: entry.terminalCreated === true,
      stale,
    }
  return {
    id: entry.id,
    title: entry.title,
    status: finished ? 'done' : 'running',
    result: entry.result ?? (exited ? '终端已退出' : gone ? '终端已关闭' : null),
    terminal,
    terminalCreated: entry.terminalCreated === true,
    /** True for the record the Host keeps for a terminal the USER opened (not a subtask). */
    userTerminal: entry.userTerminal === true,
    terminalId: entry.terminalId,
    terminalInfo: info,
    commands: entry.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
    })),
    finishedAt: entry.finishedAt,
  }
}
