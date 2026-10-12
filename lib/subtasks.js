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

/** How many entries one conversation keeps. Older finished ones are dropped, but the
 *  total is kept separately, so the count never regresses. */
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
    const finished = [...state.entries.values()]
      .filter((entry) => entry.status === 'done')
      .sort((left, right) => (left.finishedAt ?? left.updatedAt) - (right.finishedAt ?? right.updatedAt))
    while (state.entries.size > PER_SESSION_LIMIT && finished.length > 0) {
      state.entries.delete(finished.shift().id)
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
     * @param {{ terminalId?: string, terminalCreated?: boolean }} [terminal] - the shell used.
     * @returns the live entry.
     */
    start(sessionId, title, terminal) {
      const state = bucket(sessionId)
      const wanted = String(title ?? '').trim()
      for (const entry of state.entries.values()) {
        if (entry.title === wanted && entry.status !== 'done') {
          entry.updatedAt = Date.now()
          if (terminal?.terminalId !== undefined) entry.terminalId = String(terminal.terminalId)
          if (terminal?.terminalCreated === true) entry.terminalCreated = true
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
     * @param {boolean} terminalKept - true when its shell was left idle for possible follow-up
     *   work, false when it was closed. That decision is the caller's; this only records it.
     */
    finish(sessionId, title, { result, terminalKept } = {}) {
      const state = bucket(sessionId)
      const wanted = String(title ?? '').trim()
      const entry = [...state.entries.values()].find((candidate) => candidate.title === wanted && candidate.status !== 'done')
        ?? this.start(sessionId, wanted)
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
  const finished = entry.status === 'done' || gone
  const terminal = !finished
    ? 'attached'
    : gone || entry.terminalKept === false
      ? 'closed'
      : 'idle'
  const info = live === null || live === undefined
    ? null
    : {
      id: String(live.id ?? entry.terminalId ?? ''),
      title: live.title ?? null,
      shell: live.shell?.name ?? null,
      shellPath: live.shell?.path ?? null,
      args: Array.isArray(live.shell?.args) ? live.shell.args : [],
      cwd: live.cwd ?? null,
      cols: live.cols ?? null,
      rows: live.rows ?? null,
      state: live.state ?? null,
      exitCode: live.exitCode ?? null,
      toolCreated: entry.terminalCreated === true,
    }
  return {
    id: entry.id,
    title: entry.title,
    status: finished ? 'done' : 'running',
    result: entry.result ?? (gone ? '终端已关闭' : null),
    terminal,
    terminalCreated: entry.terminalCreated === true,
    terminalId: entry.terminalId,
    terminalInfo: info,
    commands: entry.commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
    })),
    finishedAt: entry.finishedAt,
  }
}
