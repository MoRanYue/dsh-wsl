// The `wsl-term` tool: read and drive the DSH session's OWN terminal — the one
// the left sidebar opens — instead of spawning a fresh shell per call.
//
// This is the one capability in this plugin that types into a shell the user is
// looking at, so it is off by default, it always releases the input attachment it
// takes, and it never closes a terminal the caller did not name.
//
// Measured against DSH 0.2.0's `terminalController`
// (`@deepseek-ai/dsh-api-terminal-controller`):
//   * `list(sessionId)` is per Session and needs no Agent;
//   * `create(agent, {id, cols, rows})` is idempotent for a live id, and an id
//     that was CLOSED can never be created again in that Session;
//   * `follow(agent, id, attachmentId, signal)` takes EXCLUSIVE input control
//     (older attachments become read-only) and yields a screen snapshot first;
//   * `write(agent, id, attachmentId, data)` is rejected unless the caller holds
//     that control ("Terminal input is controlled by another attachment");
//   * aborting the follow signal detaches and releases control.

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { destructiveReason } from '../guard.js'
import { createTerminalTransport } from '../pty-transport.js'
import {
  appendCapture,
  autoTerminalIds,
  clipTail,
  describeSessionCwd,
  extractHelperResult,
  HELPER_NAME,
  helperCall,
  helperDefinition,
  INPUT_HANDOVER_NOTE,
  looksReady,
  inputLine,
  OPENED_TERMINAL_NOTE,
  pickTerminal,
  renderTerminals,
  spillLine,
  START_PREFIX,
  stripAnsi,
} from '../terminal.js'

/** Longest a single action may hold the input attachment. */
const MAX_WAIT_MS = 120_000
/** Default wait for `run`. */
const DEFAULT_RUN_WAIT_MS = 30_000
/** Default wait for `read` (the snapshot arrives immediately; this is grace). */
const DEFAULT_READ_WAIT_MS = 1_500
/** Characters of output returned inline; past this the tail is kept and the whole
 *  capture is written to a file, because a build log's answer is at the bottom. */
const MAX_OUTPUT_CHARS = 20_000
/** Ceiling for the in-memory capture. A command like `yes` keeps streaming for the whole
 *  wait; past this the oldest characters are dropped and the result says so. */
const MAX_CAPTURE_CHARS = 4_000_000
/** How long to wait for a freshly created shell to show its first prompt before typing. */
const READY_WAIT_MS = 1_500
/** How long the detach handshake may take after the result is already decided. */
const DETACH_GRACE_MS = 2_000
/** Default geometry for a terminal this tool opens. */
const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30

/** Every action this tool accepts. The schema and the validator read the SAME list:
 *  a new action added to one and forgotten in the other is accepted by the schema and
 *  then refused at runtime as "unknown action", which is how `subtask-done` shipped
 *  dead. Keep it one list. */
const ACTIONS = ['list', 'read', 'run', 'input', 'interrupt', 'close', 'subtask-done']

/** `create` rejects ids that were closed earlier in the same Session. */
function isClosedIdentity(error) {
  return /was closed in this Session/i.test(String(error?.message ?? error))
}

/** Turn a platform Remote error into a sentence the caller can act on. */
function describeFailure(error, terminalId) {
  // The caller re-prefixes this message with the tool name, so an error that already carries it
  // (the deadline in `serviceCall`) must not end up saying `wsl-term: wsl-term: …`.
  const message = String(error?.message ?? error).replace(/^wsl-term:\s*/, '')
  const code = String(error?.code ?? '')
  if (code === 'terminal/control-unavailable' || /controlled by another attachment/i.test(message)) {
    return `terminal ${terminalId} is currently typed into by another attachment (your sidebar view); it took the input control first. Retry in a moment, or click into that terminal and press Enter to release it.`
  }
  if (code === 'terminal/unavailable') return `terminal ${terminalId} no longer exists in this session`
  return message
}

/** Await a promise but give up after `ms`, returning the TIMEOUT sentinel. */
const TIMEOUT = Symbol('timeout')
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * One call INTO the terminal service, under the same budget the caller gave the call.
 *
 * `create`, `close` and `write` reach the host, and none of them was bounded: a controller that
 * stopped answering left the tool call open past the `timeoutMs` it had declared, holding the
 * attachment — and therefore the user's terminal in read-only mode — for as long as the host felt
 * like. The frame loop has its own deadline; this is the same idea for the calls around it.
 * Fails loudly instead of hanging: the caller can retry, and nothing was typed.
 */
async function serviceCall(promise, ms, what) {
  const outcome = await withTimeout(promise, ms)
  if (outcome === TIMEOUT) {
    throw new Error(`wsl-term: the terminal service did not answer ${what} within ${ms} ms`)
  }
  return outcome
}

/** The error {@link serviceCall} raises, told apart from a real service refusal. */
function isServiceTimeout(error) {
  return /the terminal service did not answer .* within \d+ ms/.test(String(error?.message ?? error))
}

/**
 * Terminals whose shell already has {@link HELPER_NAME} defined.
 *
 * MODULE scope, not per tool instance: the definition is a property of the SHELL, and the
 * tool is rebuilt whenever a switch changes (`syncTools`), so per-instance state would
 * re-send the definition on the next command after every settings change.
 *
 * Keyed by `sessionId:terminalId`, NOT by terminal id alone. Terminal ids are per Session:
 * `list`/`create` are scoped to the calling Session, and a tool-opened terminal is named by
 * `autoTerminalIds` from a STABLE pool (`dsh-agent`, `dsh-agent-2`, …). Two conversations that
 * each get a tool-opened terminal therefore both hold an id of `dsh-agent` — in different
 * shells. Keyed by id alone, the second conversation's first `run` would skip the definition
 * line, type a call into a shell that has no such function, and report "nothing ran" while the
 * command never executed. A terminal whose shell lost the helper (a new shell inside the same
 * terminal, or a manual `unset -f`) is still detected by the missing start marker and dropped.
 */
const helperReady = new Set()
/** The identity of one shell: a terminal id is only unique inside its Session. */
const helperKey = (sessionId, terminalId) => `${String(sessionId)}:${String(terminalId)}`

export function createWslTermTool({ ctx, config, subtasks = null, transport = null }) {
  /**
   * The transport this tool was mounted against, as far as it matters to the description.
   *
   * DSH 0.1/0.2.0 exposes `terminalController.follow`/`write`: the tool can join one of the app's
   * browser terminals, which the user can watch. 0.2.1 replaced that pair with an attachment
   * that needs the CALLER's Remote invocation uplink, which a plugin cannot supply — so
   * `lib/term-bridge.js` drives the user's terminal through this plugin's own browser half while
   * the DSH window is open, and `lib/pty-transport.js` keeps a private shell as the fallback for
   * a closed window. `bridgeCapable` is a property of the build, not of the moment: the
   * description can promise the collaboration because it is available whenever a window is.
   *
   * The PER-CALL header still asks `controller.kind` each time, because a fallback shell opened
   * while the window was closed keeps working after it reopens, and the header must say which
   * shell this call is really typing into.
   */
  const bridgeCapable = (transport ?? {}).bridgeCapable === true
  const ptyOnly = !bridgeCapable && (transport ?? {}).kind === 'pty'
  /** Resolved once, not per call: a transport owns the shells it opened. */
  let resolvedTransport = transport
  const terminalTransport = () => {
    if (resolvedTransport !== null && resolvedTransport !== undefined) return resolvedTransport
    try {
      resolvedTransport = createTerminalTransport({ ctx, config })
    } catch {
      resolvedTransport = null
    }
    return resolvedTransport
  }
  /**
   * Persist the complete output so clipping never loses anything.
   *
   * The platform's `spillStore` is the sanctioned writer (session-scoped, private,
   * collision-free name); a temp file is the fallback for a build that does not serve
   * it. Both are best effort: a storage failure keeps the inline result rather than
   * failing a command that already ran.
   * @param {{ agent: { id: string }, label: string, content: string }} request - owner, label and full text.
   * @returns one line naming the file, or an empty string when nothing could be saved.
   */
  async function spillOutput({ agent, label, content }) {
    const spillStore = ctx.get('spillStore')
    if (spillStore !== undefined && typeof spillStore.saveText === 'function') {
      try {
        const ref = await spillStore.saveText({
          owner: { sessionId: agent.id },
          source: { kind: 'session-reference', sessionId: agent.id, label: `wsl-term ${label}` },
          suggestedName: `wsl-term-${label}.log`,
          content,
        })
        const line = spillLine(ref)
        if (line !== '') return line
      } catch (error) {
        console.warn('dsh-wsl-tool: spilling terminal output failed', error)
      }
    }
    try {
      const file = join(tmpdir(), `dsh-wsl-term-${randomUUID().slice(0, 8)}.log`)
      writeFileSync(file, content, 'utf8')
      return spillLine({ locator: file, bytes: Buffer.byteLength(content, 'utf8') })
    } catch (error) {
      console.warn('dsh-wsl-tool: writing terminal output to a file failed', error)
      return ''
    }
  }

  /**
   * Render one capture: short output inline, long output as its tail plus a file.
   * @param {{ agent: { id: string }, label: string, text: string }} request - owner, label, full text.
   * @returns the text to return, with the spill line appended when it was clipped.
   */
  async function renderBody({ agent, label, text }) {
    const body = String(text ?? '').trimEnd()
    if (body.length <= MAX_OUTPUT_CHARS) return body
    const spill = await spillOutput({ agent, label, content: body })
    const tail = clipTail(body, MAX_OUTPUT_CHARS)
    return spill === '' ? tail : `${tail}\n${spill}`
  }

  return {
    name: 'wsl-term',
    description:
      'Work in this session\'s own terminal instead of a fresh shell per call. Reach for it when the work needs ONE ' +
      'shell across several steps — a long build worth watching, an interactive program, state that has to persist. ' +
      'For anything self-contained the plain `wsl` tool is better: it runs in parallel, needs no terminal, and never ' +
      'takes the keyboard from the user. `list` shows the terminals; `read` the screen; `run` types one command and ' +
      'returns its output and exit code (the same dangerous-command guard applies; an intended one needs ' +
      '`allowDangerous: true`); `input` sends raw keystrokes; `interrupt` Ctrl-C; `close` ends a named terminal. ' +
      (bridgeCapable
        ? 'A `run` WITH a `subtask` uses a private shell this tool opens (it may not appear as a sidebar tab, only ' +
          'this tool types into it), so `close` it when the subtask is done. WITHOUT a `subtask`, an ad-hoc command ' +
          'runs in the terminal YOU have open: commands are visible there, your view is read-only until you click ' +
          '接管输入, and the tool never closes it. Terminals it did not open are never closed here; `id` picks ' +
          'one. '
        : ptyOnly
          ? 'This DSH does not let a plugin join the sidebar terminal, so one WSL shell is opened here per subtask: it ' +
            'does not appear in the sidebar, only this tool types into it, and `subtask-done` with `keepTerminal: false` ' +
            'closes it when the work is finished. '
          : 'An ad-hoc command runs in the terminal you have open (read-only while the tool works; the tool never ' +
            'closes it). With a `subtask`, one is opened here per subtask — it may not appear as a sidebar tab — so ' +
            '`close` it when the subtask is done. A terminal you opened is never closed here. ') +
      'Commands run as the user, outside the DSH sandbox.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'What to do with the terminal.',
        },
        subtask: {
          type: 'string',
          description:
            'The name of the piece of work this call belongs to, in the user\'s language (e.g. "跑通 sta 流程"). '
            + 'It is what the client shows above the composer, so give it once and reuse it for every step of that '
            + 'work. `subtask-done` needs it too.',
        },
        result: { type: 'string', description: 'For `subtask-done`: one line saying how that work ended.' },
        keepTerminal: {
          type: 'boolean',
          description:
            'For `subtask-done`: `true` (the default) leaves the shell idle for a follow-up step, `false` closes it. '
            + 'Leave it idle while more steps are plausible, close it when the work is finished for good.',
        },
        id: {
          type: 'string',
          description:
            'Terminal id from `list`. Defaults to the newest running terminal, or one opened here when none exists.',
        },
        command: { type: 'string', description: 'Command line for `run` (needs a POSIX-style shell such as bash or zsh).' },
        allowDangerous: {
          type: 'boolean',
          description:
            'For `run`: the command looks destructive (a delete, a partition, a shutdown). '
            + 'Pass `true` only when that is intended.',
        },
        data: { type: 'string', description: 'Raw keystrokes for `input`, e.g. a Tab or an arrow-key escape.' },
        submit: { type: 'boolean', description: 'For `input`: append Enter after the keystrokes.' },
        timeoutMs: {
          type: 'number',
          description: `How long \`run\`/\`read\` wait before detaching (default ${DEFAULT_RUN_WAIT_MS}, max ${MAX_WAIT_MS}).`,
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      // The transport is resolved once per tool instance and shared with the subtask route
      // (index.js); resolving it per call would give every call its own empty registry, so
      // `close` would silently close nothing.
      const controller = terminalTransport()
      if (controller === null || controller === undefined || typeof controller.follow !== 'function') {
        throw new Error(
          'wsl-term: this DSH build offers no terminal this plugin can drive — it needs either a '
          + '`terminalController` with follow/write (DSH 0.1–0.2.0) or a `subprocess` provider with `spawnTerminal`',
        )
      }
      // Same contract as the platform's own persistent-shell tools: the caller's
      // Agent IS the terminal owner, and without it there is nothing to act on.
      const agent = exec?.agent
      if (agent === undefined || agent === null) {
        throw new Error('wsl-term: needs an owning agent session (exec.agent was not provided)')
      }
      const action = String(args?.action ?? '')
      if (!ACTIONS.includes(action)) {
        throw new Error(`wsl-term: unknown action "${action}"`)
      }
      const id = typeof args?.id === 'string' && args.id.length > 0 ? args.id : undefined
      const waitMs = (() => {
        if (args?.timeoutMs === undefined) return action === 'read' ? DEFAULT_READ_WAIT_MS : DEFAULT_RUN_WAIT_MS
        const value = args.timeoutMs
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
          throw new Error('wsl-term: timeoutMs must be a positive number')
        }
        return Math.min(Math.round(value), MAX_WAIT_MS)
      })()

      const sessionId = agent.id
      const listTerminals = () => {
        const infos = controller.list(sessionId)
        return Array.isArray(infos) ? infos : []
      }
      /** Terminals the USER opened; only a live page can drive them (the bridge). */
      const userTerminals = () => {
        if (typeof controller.userTerminals !== 'function') {
          // Older hosts expose only browser terminals through the controller, and those ARE the
          // user's: keep the pre-bridge behaviour there instead of reporting "none".
          return listTerminals()
        }
        try {
          const listed = controller.userTerminals(sessionId)
          return Array.isArray(listed) ? listed : []
        } catch {
          return []
        }
      }
      /** Whether this plugin opened the terminal itself (only those may be closed by it). */
      const ownsTerminal = (candidate) => {
        if (typeof controller.owns !== 'function') return true
        try {
          return controller.owns(sessionId, candidate.id) === true
        } catch {
          return true
        }
      }

      if (action === 'list') {
        const owned = listTerminals()
        const shared = userTerminals()
        const lines = owned.length > 0
          ? [...renderTerminals(owned, undefined)]
          : ['no shell opened by this tool is running']
        if (shared.length > 0) {
          lines.push('', 'terminals YOU opened (collaboration targets for ad-hoc commands; read-only while the tool types, never closed by it):')
          for (const entry of shared) {
            lines.push(`- id=${entry.id} "${entry.title ?? ''}" ${entry.shell?.name ?? 'shell'} · `
              + `${entry.cols}x${entry.rows} · ${entry.state} · ${inputLine(entry)}`)
          }
        } else {
          lines.push('', 'no terminal you opened is open right now')
        }
        lines.push('', '`run` WITHOUT `subtask` uses the newest running terminal you opened; with `subtask` it uses a '
          + 'private shell this tool manages. Name `id` to pick one explicitly.')
        return { summary: lines.join('\n') }
      }

      // `subtask-done` needs no terminal attached: it closes the record, and closes the shell
      // only when this tool opened it AND the caller says the work is finished for good. A
      // terminal the user opened is never closed here — the same rule the `close` action has.
      if (action === 'subtask-done') {
        const title = typeof args?.subtask === 'string' ? args.subtask.trim() : ''
        if (title === '') throw new Error('wsl-term: subtask-done needs `subtask` (the same name the steps used)')
        const keepTerminal = args?.keepTerminal !== false
        const entry = subtasks === null
          ? null
          : subtasks.finish(sessionId, title, { result: args?.result, terminalKept: keepTerminal })
        let closed = false
        let closeStalled = false
        if (!keepTerminal && entry !== null && entry.terminalCreated && entry.terminalId !== null) {
          try {
            await serviceCall(controller.close(agent, entry.terminalId), waitMs, 'the request to close the terminal')
            closed = true
            helperReady.delete(helperKey(sessionId, entry.terminalId))
          } catch (error) {
            // Already gone (the user closed it, or the app rebuilt the tab) is not a failure.
            if (isClosedIdentity(error)) {
              // Gone is the outcome that was wanted; nothing to report.
            } else if (isServiceTimeout(error)) {
              // The record is already finished and this is a courtesy close: a silent service must
              // not turn a finished subtask into a failed call. Say it, so the caller knows the
              // shell may still be open.
              closeStalled = true
            } else {
              throw error
            }
          }
        }
        return {
          summary: [
            `subtask "${title}" is done.`,
            entry?.result === null || entry?.result === undefined ? null : `result: ${entry.result}`,
            entry === null
              ? 'terminal: not tracked in this build'
              : entry.terminalCreated
                ? (closed
                  ? 'terminal: closed (this tool opened it)'
                  : closeStalled
                    ? `terminal: the close request went unanswered for ${waitMs} ms — the shell may still be open`
                    : 'terminal: kept idle for a follow-up step')
                : 'terminal: left alone (the user opened it)',
          ].filter((line) => line !== null).join('\n'),
        }
      }

      // Argument checks come FIRST, before anything is selected or opened: a refused call
      // must not leave a side effect behind (a terminal created in the user's sidebar for a
      // call that could never run).
      if (action === 'close' && id === undefined) {
        throw new Error('wsl-term: close needs an explicit id (use action "list")')
      }
      if (action === 'run' && (typeof args?.command !== 'string' || args.command.trim() === '')) {
        throw new Error('wsl-term: run needs a non-empty command')
      }
      // The same guard the one-shot `wsl` tool applies, for the same reason and BEFORE anything
      // is selected or typed: a terminal is the one place where a mistyped command lands in a
      // shell the user is watching. `input` cannot be inspected — it is raw keystrokes — so the
      // guard covers `run` only, and the refusal must not touch the terminal at all.
      if (action === 'run') {
        const reason = destructiveReason(args.command)
        if (reason !== null && args.allowDangerous !== true && config.dangerGuard) {
          throw new Error(
            `wsl-term: refused a destructive command (${reason}). ` +
            'If this is intended, re-issue it with `allowDangerous: true`.',
          )
        }
      }
      // Composed here so a command that cannot be typed as one line is refused before a
      // terminal is opened for it. The nonce travels in the call line: it is what keeps this
      // call's markers unambiguous against the echoed definition line.
      const runNonce = action === 'run' ? randomUUID().replaceAll('-', '').slice(0, 8) : null
      const runCall = action === 'run' ? helperCall(args.command, runNonce) : null
      if (action === 'input' && (typeof args?.data !== 'string' || args.data.length === 0)) {
        throw new Error('wsl-term: input needs non-empty data (raw keystrokes)')
      }

      // ------------------------------------------------------------ selection
      //
      // Owner decision (2026-10-23, refined after the second round of feedback):
      //   * a `run` WITH a `subtask` is tracked work → it goes to a shell THIS TOOL opens
      //     (private PTY). The user's own long-lived terminal never becomes a managed subtask
      //     shell, so it can never be closed by subtask bookkeeping.
      //   * an ad-hoc command (no `subtask`) → the terminal the user has open, when a page can
      //     drive it. That IS the collaboration: commands run visibly in the user's shell,
      //     which stays read-only during the call and is never closed.
      //   * a named `id` always wins (an explicit request, user terminal or not).
      const ownTerminals = () => listTerminals()
      const tracked = action === 'run' && typeof args?.subtask === 'string' && args.subtask.trim() !== ''

      let opened = false
      let external = false
      let explicit = false
      let info = null
      let vanished = null
      if (id !== undefined) {
        explicit = true
        info = pickTerminal(ownTerminals(), id)
        if (info !== null) {
          external = !ownsTerminal(info)
        } else {
          // An id this plugin did not open (the user's own terminal), or one that is gone.
          const described = typeof controller.describe === 'function' ? controller.describe(sessionId, id) : null
          if (action === 'close') {
            if (described !== null && described !== undefined) {
              throw new Error(
                `wsl-term: terminal "${id}" was not opened by this tool, so it is not closed from here — `
                + 'close it from the sidebar instead',
              )
            }
            throw new Error(`wsl-term: no terminal with id "${id}" in this session (use action "list")`)
          }
          if (described !== null && described !== undefined) {
            info = described
            external = true
          } else {
            // An id can stop existing with nobody closing anything: the app ties a terminal's life
            // to its tab being retained, and re-creating that tab yields a NEW id (measured). The
            // call falls back to one of this tool's own shells, or opens one, and the header says so.
            vanished = id
          }
        }
      } else if (!tracked && action !== 'close') {
        // Collaborative ad-hoc call: prefer the terminal the user has open and can watch.
        info = pickTerminal(userTerminals(), undefined)
        if (info !== null) external = true
      }
      if (info === null && vanished !== null) {
        // The named terminal is gone: use one of this tool's own shells instead of failing the
        // call, and let the header say which one (the caller cannot keep an id in sync).
        info = pickTerminal(ownTerminals(), undefined)
      }
      if (info === null) info = pickTerminal(ownTerminals(), undefined)
      if (info === null) {
        // `create` composes its own AbortSignal.any([...]), so this MUST be a real AbortSignal: a
        // tool execution context does not always carry one, and `undefined` there throws inside
        // the platform rather than failing clearly.
        const signal = exec?.signal instanceof AbortSignal ? exec.signal : new AbortController().signal
        const candidates = autoTerminalIds(ownTerminals())
        let failure = null
        for (const candidate of candidates) {
          try {
            info = await serviceCall(
              controller.create(agent, { id: candidate, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, signal),
              waitMs,
              'the request to open a terminal',
            )
            opened = true
            break
          } catch (error) {
            failure = error
            if (!isClosedIdentity(error)) break
          }
        }
        if (info === null || info === undefined) {
          throw new Error(`wsl-term: could not open a terminal: ${describeFailure(failure, 'dsh-agent')}`)
        }
      }
      // The header says which shell this call is really typing into: a private PTY this tool
      // manages, or a terminal the user opened (collaboration or an explicit request).
      const kind = typeof controller.kindOf === 'function' ? controller.kindOf(sessionId, info.id) : controller.kind
      const pty = kind === 'pty'

      const header = [
        `terminal ${info.id} "${info.title ?? ''}" (${info.shell?.name ?? 'shell'})`,
        `${describeSessionCwd(info.cwd)} · ${info.cols}x${info.rows} · ${info.state}`,
        pty ? 'input: this tool owns the shell (there is no separate viewer to take it)' : inputLine(info),
        pty
          ? 'opened by this tool for this session; it is private to the tool and does not appear in the sidebar'
          : external
            ? explicit
              ? 'a terminal YOU opened; this call named its id — your view is read-only while the tool works, '
                + 'and it is never closed here'
              : 'a terminal YOU opened — this call is collaborative: your view is read-only until you click 接管输入, '
                + 'and the tool never closes it'
            : opened ? OPENED_TERMINAL_NOTE : 'a shell this tool opened for this session (it may not be a sidebar tab)',
      ]
      if (vanished !== null) {
        header.push(`note: terminal "${vanished}" is gone (the app can re-create a terminal under a new id); `
          + `${opened ? 'a new one was opened' : 'one of this tool\'s own shells was used'} instead — this is ${info.id}`)
      }

      // The client's dock row needs the subtask to EXIST while it runs, not only when it is
      // reported: a running entry is what puts this work at the top of that list. A subtask only
      // ever lands on a shell this tool manages — except when the caller explicitly named a user
      // terminal AND asked for a subtask, which is then recorded but never closed.
      if (tracked && subtasks !== null && (!external || explicit)) {
        subtasks.start(sessionId, args.subtask, {
          terminalId: info.id,
          // Only a shell opened by THIS call counts as the tool's own; an existing terminal is
          // never closed by subtask bookkeeping.
          terminalCreated: opened,
          // The detail can still describe the shell after it is closed: this is the description
          // from the last moment the tool saw it alive.
          terminalSnapshot: info,
        })
      }

      if (action === 'close') {
        // `id` was required above and the target came from this tool's own list: a terminal the
        // user opened never reaches this point (the explicit-id branch refuses it).
        if (!ownsTerminal(info)) {
          throw new Error(`wsl-term: terminal "${info.id}" was not opened by this tool, so it is not closed here`)
        }
        await serviceCall(controller.close(agent, info.id), waitMs, 'the request to close the terminal')
        // Closing a shell ends the work that shell was doing: any subtask still marked running
        // on it is closed too, so the dock row cannot keep claiming a terminal that is gone.
        if (subtasks !== null) {
          for (const entry of subtasks.list(sessionId).entries) {
            if (entry.status !== 'done' && entry.terminalId !== null
              && String(entry.terminalId) === String(info.id)) {
              subtasks.finish(sessionId, entry.title, { result: '终端已关闭', terminalKept: false })
            }
          }
        }
        return { summary: [...header, 'closed.'].join('\n') }
      }

      const attachmentId = `agent-${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const detach = new AbortController()
      // A cancelled tool call must hand the keyboard back at once, not at the end of this loop's
      // own deadline: tying the caller's abort to the detach controller is what closes the
      // attachment that holds the user's terminal read-only.
      const onCallerAbort = () => detach.abort(new Error('wsl-term cancelled'))
      if (exec?.signal instanceof AbortSignal) {
        if (exec.signal.aborted) detach.abort(new Error('wsl-term cancelled'))
        else exec.signal.addEventListener('abort', onCallerAbort, { once: true })
      }
      // Attaching displaces whatever held input, and detaching empties the slot
      // rather than restoring it (measured: the view then shows 此页面当前只读 with a
      // 接管输入 button). Every action that attaches carries that warning, so the
      // model can tell the user instead of leaving them typing into nothing.
      if (!pty) header.push(INPUT_HANDOVER_NOTE)
      let snapshot = null
      let captured = ''
      let dropped = 0
      let exitInfo = null
      let timedOut = false
      // Declared outside the try so the result can say whether anything was actually typed:
      // a deadline that expires before the first frame means NOTHING was sent, and reporting
      // the opposite is worse than reporting nothing.
      let submitted = false

      // Both were validated before a terminal was chosen (see the top of this branch), so
      // nothing here can take the keyboard for a call that cannot run.

      let iterator = null
      let helperSent = helperReady.has(helperKey(sessionId, info.id))
      try {
        const frames = controller.follow(agent, info.id, attachmentId, detach.signal)
        iterator = frames[Symbol.asyncIterator]()
        const deadline = Date.now() + waitMs
        // Readiness window, anchored to the SNAPSHOT rather than to the call: a slow attach can
        // push the first snapshot past a call-anchored window, and then the gate would never be
        // consulted at all — which is exactly the failure it exists to prevent (the helper's
        // definition line vanishing into a shell that is still starting).
        let readyBy = null
        /**
         * Type the call, once the conditions for it hold.
         *
         * Checked after EVERY frame, not only on the snapshot: a terminal this tool has just
         * created spends its first frames still starting, and the prompt that makes it safe to
         * type arrives as an ordinary output frame afterwards. Typing before that prompt loses
         * the write — measured: the helper's definition vanished and the command came back
         * "command not found".
         * @returns true when something was typed.
         */
        const tryWrite = async () => {
          if (submitted || snapshot === null) {
            return false
          }
          // Never type into a shell that is still starting: `run` always waits, and `input`
          // waits too when THIS call is the one that created the terminal. `interrupt` never
          // waits — a Ctrl-C is meant to land during whatever is on screen.
          const gated = action === 'run' || (action === 'input' && opened)
          if (gated && readyBy !== null && !looksReady(`${snapshot}\n${captured}`) && Date.now() < readyBy) {
            return false
          }
          if (action === 'run') {
            // The helper is defined ONCE per terminal: it is what makes every later call a
            // single short line the user can read (`__dsh_term_run k3f9a2 'make syn'`) instead
            // of the command buried inside marker printing.
            if (!helperSent) {
              await serviceCall(
                controller.write(agent, info.id, attachmentId, `\u0015${helperDefinition()}\r`),
                waitMs,
                'the keystrokes',
              )
              helperSent = true
              helperReady.add(helperKey(sessionId, info.id))
            }
            await serviceCall(
              controller.write(agent, info.id, attachmentId, `\u0015${runCall}\r`),
              waitMs,
              'the keystrokes',
            )
          } else if (action === 'input') {
            await serviceCall(
              controller.write(agent, info.id, attachmentId, args.submit === true ? `${args.data}\r` : args.data),
              waitMs,
              'the keystrokes',
            )
          } else if (action === 'interrupt') {
            await serviceCall(
              controller.write(agent, info.id, attachmentId, '\u0003'),
              waitMs,
              'the keystrokes',
            )
          } else {
            return false
          }
          submitted = true
          return true
        }
        let inFlight = null
        while (true) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            timedOut = true
            break
          }
          // While the write is still pending, poll instead of sleeping to the deadline, so a shell
          // that sends nothing else can still be typed into once the readiness window is over.
          // Measured from a frame trace: one snapshot arrived, nothing else did, and the command
          // was never typed because this loop was parked in `next()`.
          //
          // The SAME promise is reused across a poll. An async generator queues concurrent
          // `next()` calls FIFO and hands each yielded frame to the one at the head, so an
          // abandoned request silently swallows one future frame — the command's own markers
          // included — and the call then waits out its whole deadline for a command that already
          // finished. One request in flight, always.
          const pending = !submitted && snapshot !== null
          if (inFlight === null) inFlight = iterator.next()
          const step = await withTimeout(inFlight, pending ? Math.min(remaining, 250) : remaining)
          if (step === TIMEOUT) {
            if (!submitted && Date.now() < deadline) {
              await tryWrite()
              continue
            }
            timedOut = true
            break
          }
          inFlight = null
          if (step.done) break
          const frame = step.value
          if (frame?.type === 'snapshot') {
            // The snapshot proves we are attached and holding the input control.
            snapshot = frame.screen
            if (readyBy === null) readyBy = Math.min(deadline, Date.now() + READY_WAIT_MS)
            await tryWrite()
            // One keystroke is the whole call: break here, or the tool stays attached to the
            // user's terminal (keeping it read-only) until the deadline for nothing.
            if ((action === 'interrupt' || action === 'input') && submitted) break
            continue
          }
          if (frame?.type === 'output') {
            // Strip per frame, not per iteration: re-cleaning the whole capture on every
            // frame is quadratic, and a chatty command fills the capture for MAX_WAIT_MS.
            const step2 = appendCapture(captured, frame.data, MAX_CAPTURE_CHARS)
            captured = step2.text
            dropped += step2.dropped
            // The prompt of a shell that was still starting arrives here, so this is where a
            // delayed `run` finally types its command.
            await tryWrite()
            if (action === 'run' && extractHelperResult(captured, runNonce).complete) break
            continue
          }
          if (frame?.type === 'state') {
            info = frame.info ?? info
            if (info?.state !== 'running') {
              exitInfo = info
              break
            }
          }
        }
      } catch (error) {
        throw new Error(`wsl-term: ${describeFailure(error, info.id)}`)
      } finally {
        if (exec?.signal instanceof AbortSignal) exec.signal.removeEventListener('abort', onCallerAbort)
        // Aborting detaches, and detaching is what hands the keyboard back. Await
        // the generator's own completion too, so this tool cannot return — let
        // alone report success — while it still holds the user's input control.
        detach.abort(new Error('wsl-term detached'))
        if (iterator !== null && typeof iterator.return === 'function') {
          try {
            // Bounded: a transport that ignores the abort would otherwise hold the call open
            // far past `waitMs`, and the result is already decided by then. The timer is cleared
            // either way, so it cannot keep the process alive after the race is decided.
            let grace = null
            try {
              await Promise.race([
                Promise.resolve(iterator.return()).then(() => undefined, () => undefined),
                new Promise((resolve) => { grace = setTimeout(resolve, DETACH_GRACE_MS) }),
              ])
            } finally {
              if (grace !== null) clearTimeout(grace)
            }
          } catch {
            // Detaching already succeeded; a generator teardown error is not the
            // caller's problem and must not replace the real result.
          }
        }
      }

      if (action === 'interrupt') {
        return {
          summary: [
            ...header,
            submitted
              ? 'sent Ctrl-C (SIGINT).'
              : `nothing was sent: the terminal produced no snapshot within ${waitMs} ms.`,
          ].join('\n'),
        }
      }
      if (action === 'input') {
        return {
          summary: [
            ...header,
            submitted
              ? `sent ${JSON.stringify(args.data)}${args.submit === true ? ' with Enter' : ''}.`
              : `nothing was sent: the terminal produced no snapshot within ${waitMs} ms.`,
          ].join('\n'),
        }
      }

      const screen = stripAnsi(snapshot ?? '')
      if (action === 'read') {
        const live = stripAnsi(captured)
        const body = [screen, live].filter((part) => part.trim().length > 0).join('\n')
        const rendered = body.trim().length > 0
          ? await renderBody({ agent, label: 'screen', text: body })
          : '(the screen was empty)'
        return {
          summary: [
            ...header,
            `screen (viewport of the host terminal emulator; anything older has scrolled out of the buffer):`,
            rendered,
          ].join('\n'),
        }
      }

      // action === 'run'
      const extracted = extractHelperResult(captured, runNonce)
      // One line in the client's dock row comes from here: the subtask this command belonged to
      // gets the command and its exit code. Recorded once, at the single point every run result
      // passes through, so a refused or never-typed command cannot appear as if it had run.
      if (subtasks !== null && typeof args?.subtask === 'string' && args.subtask.trim() !== '' && submitted) {
        subtasks.recordCommand(sessionId, args.subtask, String(args.command).trim(),
          extracted.complete ? extracted.exitCode : null)
      }
      if (extracted.complete) {
        const output = extracted.output !== null && extracted.output.length > 0
          ? await renderBody({ agent, label: 'run-output', text: extracted.output })
          : '(no output)'
        return {
          summary: [
            ...header,
            `$ ${String(args.command).trim()}`,
            output,
            `exit code: ${extracted.exitCode}`,
          ].join('\n'),
        }
      }
      // No start marker for THIS call's nonce: nothing ran. The likeliest reason is that this
      // shell no longer has the helper (a new shell inside the same terminal, or a manual
      // `unset -f`) — but a shell still busy with an earlier command reads the same way, so the
      // message says both and the next call defines the helper again.
      //
      // Matching the bare prefix would be wrong: the helper's own definition line contains
      // `#DSH-START:` and is echoed into this same stream, so the echo alone would pass for a
      // marker — the accurate message would never fire and the helper would never be re-sent.
      //
      // `dropped === 0` is part of the condition: a capture past its ceiling loses its HEAD, and
      // this call's marker can be in what fell off — a command that ran perfectly well would then
      // be reported as "this shell has no helper". When the capture is partial, the honest answer
      // is the one below (`(the capture is partial: …)`), not a diagnosis of the shell.
      const helperMissing = submitted && dropped === 0 && !captured.includes(`${START_PREFIX}${runNonce}`)
      if (helperMissing) helperReady.delete(helperKey(sessionId, info.id))
      if (exitInfo !== null) {
        return {
          summary: [
            ...header,
            `$ ${String(args.command).trim()}`,
            '(the command did not return before the shell exited)',
            `terminal state: ${exitInfo.state}${exitInfo.exitCode === null || exitInfo.exitCode === undefined ? '' : ` (exit ${exitInfo.exitCode})`}`,
          ].join('\n'),
        }
      }
      const capturedBody = captured.trim().length > 0
        ? await renderBody({ agent, label: 'run-output', text: captured })
        : '(no output captured)'
      return {
        summary: [
          ...header,
          `$ ${String(args.command).trim()}`,
          helperMissing
            ? `(nothing ran: this shell has no \`${HELPER_NAME}\` — it is defined here once, so a restarted shell `
              + 'or an `unset -f` removes it — or the shell was busy. The next `run` defines it again.)'
            : submitted
              ? (timedOut
                ? `(still running after ${waitMs} ms; the command was typed but did not report an exit code)`
                : '(no completion marker was seen)')
              : `(nothing was typed: the terminal produced no snapshot within ${waitMs} ms)`,
          capturedBody,
          dropped > 0 ? `(the capture is partial: its first ${dropped} characters were dropped)` : null,
          'The command may still be running in that terminal — `interrupt` sends Ctrl-C.',
        ].filter((line) => line !== null).join('\n'),
      }
    },
    presentCall: () => ({ card: 'terminal', title: 'Work in the session terminal' }),
  }
}
