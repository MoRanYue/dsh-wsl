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
//   * `follow(agent, id, attachmentId)` takes EXCLUSIVE input control (older
//     attachments become read-only) and yields a screen snapshot first;
//   * `write(agent, id, attachmentId, data)` is rejected unless the caller holds
//     that control ("Terminal input is controlled by another attachment");
//   * aborting the follow signal detaches and releases control.

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** `create` rejects ids that were closed earlier in the same Session. */
function isClosedIdentity(error) {
  return /was closed in this Session/i.test(String(error?.message ?? error))
}

/** Turn a platform Remote error into a sentence the caller can act on. */
function describeFailure(error, terminalId) {
  const message = String(error?.message ?? error)
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
 * Terminals whose shell already has {@link HELPER_NAME} defined.
 *
 * MODULE scope, not per tool instance: the definition is a property of the SHELL, and the
 * tool is rebuilt whenever a switch changes (`syncTools`), so per-instance state would
 * re-send the definition on the next command after every settings change. Keyed by terminal
 * id, which is a client-generated UUID or a name `closedIds` prevents from being reused in
 * the same run. A terminal whose shell lost it (a new shell inside the same terminal, or a
 * manual `unset -f`) is detected by the missing start marker and dropped from this set, so the
 * next call defines it again.
 */
const helperReady = new Set()

export function createWslTermTool({ ctx, config }) {
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
      'Work in this session\'s own terminal instead of a fresh shell per call. `list` shows the open terminals; ' +
      '`read` returns the current screen; `run` types one command into a terminal and returns its output and exit ' +
      'code; `input` sends raw keystrokes; `interrupt` sends Ctrl-C; `close` ends a named terminal. A terminal the ' +
      'user opened is preferred — the newest running one is used when `id` is omitted — and when the session has ' +
      'none, one is opened here (it will not appear as a sidebar tab). While attached, the user\'s terminal is ' +
      'read-only, and it stays that way until they take input back. Needs the terminal switch in the panel; commands ' +
      'run as the user, outside the DSH sandbox.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'run', 'input', 'interrupt', 'close'],
          description: 'What to do with the terminal.',
        },
        id: {
          type: 'string',
          description:
            'Terminal id from `list`. Defaults to the newest running terminal, or one opened here when none exists.',
        },
        command: { type: 'string', description: 'Command line for `run` (needs a POSIX-style shell such as bash or zsh).' },
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
      const controller = ctx.get('terminalController')
      if (controller === undefined) {
        throw new Error('wsl-term: this DSH build has no terminalController service, so the sidebar terminal is unavailable')
      }
      // Same contract as the platform's own persistent-shell tools: the caller's
      // Agent IS the terminal owner, and without it there is nothing to act on.
      const agent = exec?.agent
      if (agent === undefined || agent === null) {
        throw new Error('wsl-term: needs an owning agent session (exec.agent was not provided)')
      }

      const action = String(args?.action ?? '')
      if (!['list', 'read', 'run', 'input', 'interrupt', 'close'].includes(action)) {
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

      if (action === 'list') {
        const infos = listTerminals()
        return {
          summary: [
            ...renderTerminals(infos, undefined),
            '',
            'Read or drive one with `id`; `run` types into the newest running terminal when `id` is omitted.',
          ].join('\n'),
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
      // Composed here so a command that cannot be typed as one line is refused before a
      // terminal is opened for it. The nonce travels in the call line: it is what keeps this
      // call's markers unambiguous against the echoed definition line.
      const runNonce = action === 'run' ? randomUUID().replaceAll('-', '').slice(0, 8) : null
      const runCall = action === 'run' ? helperCall(args.command, runNonce) : null
      if (action === 'input' && (typeof args?.data !== 'string' || args.data.length === 0)) {
        throw new Error('wsl-term: input needs non-empty data (raw keystrokes)')
      }

      // Everything below acts on one terminal. Opening one is the documented fallback when
      // the session has none: it is a real shell for that session, but the sidebar's tabs
      // belong to the app's layout owner, so an opened terminal is NOT guaranteed a tab
      // (measured) — which is why the header says so and the READMEs recommend opening one
      // yourself first.
      let opened = false
      let info = pickTerminal(listTerminals(), id)
      // An id can stop existing with nobody closing anything: the app ties a terminal's
      // life to its tab being retained, and re-creating that tab yields a NEW id (measured:
      // a terminal this tool had just listed was gone minutes later while its tab was still
      // on screen — the client's own comment is "a view survives DOM unmount; its process
      // only ends on explicit close"). Failing the action there breaks a workflow over a
      // name the caller cannot keep in sync, so a vanished id falls back to the newest
      // running terminal, or opens one — and the header says so out loud. `close` is the
      // exception: it must never end a terminal the caller did not name.
      let vanished = null
      if (info === null && id !== undefined && action !== 'close') {
        vanished = id
        info = pickTerminal(listTerminals(), undefined)
      }
      if (info === null && id !== undefined && action === 'close') {
        throw new Error(`wsl-term: no terminal with id "${id}" in this session (use action "list")`)
      }
      if (info === null) {
        // `create` composes its own AbortSignal.any([...]), so this MUST be a real
        // AbortSignal: a tool execution context does not always carry one, and
        // `undefined` there throws inside the platform rather than failing clearly.
        const signal = exec?.signal instanceof AbortSignal ? exec.signal : new AbortController().signal
        const candidates = autoTerminalIds(listTerminals())
        let failure = null
        for (const candidate of candidates) {
          try {
            info = await controller.create(agent, { id: candidate, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }, signal)
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

      const header = [
        `terminal ${info.id} "${info.title ?? ''}" (${info.shell?.name ?? 'shell'})`,
        `${describeSessionCwd(info.cwd)} · ${info.cols}x${info.rows} · ${info.state}`,
        inputLine(info),
        opened ? OPENED_TERMINAL_NOTE : 'existing terminal in this session',
      ]
      if (vanished !== null) {
        header.push(`note: terminal "${vanished}" is gone (the app can re-create a terminal under a new id); `
          + `${opened ? 'a new one was opened' : 'the newest running terminal was used'} instead — this is ${info.id}`)
      }

      if (action === 'close') {
        // `id` was required above (before any terminal was selected or opened), so the
        // target here is the terminal the caller named.
        await controller.close(agent, info.id)
        return { summary: [...header, 'closed.'].join('\n') }
      }

      const attachmentId = `agent-${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const detach = new AbortController()
      // Attaching displaces whatever held input, and detaching empties the slot
      // rather than restoring it (measured: the view then shows 此页面当前只读 with a
      // 接管输入 button). Every action that attaches carries that warning, so the
      // model can tell the user instead of leaving them typing into nothing.
      header.push(INPUT_HANDOVER_NOTE)
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
      let helperSent = helperReady.has(info.id)
      try {
        const frames = controller.follow(agent, info.id, attachmentId, detach.signal)
        iterator = frames[Symbol.asyncIterator]()
        const deadline = Date.now() + waitMs
        // Readiness window: never longer than the call itself.
        const readyBy = Math.min(deadline, Date.now() + READY_WAIT_MS)
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
          if (action === 'run' && !looksReady(`${snapshot}\n${captured}`) && Date.now() < readyBy) {
            return false
          }
          if (action === 'run') {
            // The helper is defined ONCE per terminal: it is what makes every later call a
            // single short line the user can read (`__dsh_term_run k3f9a2 'make syn'`) instead
            // of the command buried inside marker printing.
            if (!helperSent) {
              await controller.write(agent, info.id, attachmentId, `\u0015${helperDefinition()}\r`)
              helperSent = true
              helperReady.add(info.id)
            }
            await controller.write(agent, info.id, attachmentId, `\u0015${runCall}\r`)
          } else if (action === 'input') {
            await controller.write(agent, info.id, attachmentId, args.submit === true ? `${args.data}\r` : args.data)
          } else if (action === 'interrupt') {
            await controller.write(agent, info.id, attachmentId, '\u0003')
          } else {
            return false
          }
          submitted = true
          return true
        }
        while (true) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            timedOut = true
            break
          }
          // While the write is still pending, never sleep until the deadline: the shell may send
          // no further frame at all, and the readiness window (or a write that is simply due) has
          // to be able to fire anyway. Measured from a frame trace: one snapshot arrived, nothing
          // else did, and the command was never typed because this loop was parked in `next()`.
          const pending = !submitted && snapshot !== null
          const step = await withTimeout(iterator.next(), pending ? Math.min(remaining, 250) : remaining)
          if (step === TIMEOUT) {
            if (!submitted && Date.now() < deadline) {
              await tryWrite()
              continue
            }
            timedOut = true
            break
          }
          if (step.done) break
          const frame = step.value
          if (frame?.type === 'snapshot') {
            // The snapshot proves we are attached and holding the input control.
            snapshot = frame.screen
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
        // Aborting detaches, and detaching is what hands the keyboard back. Await
        // the generator's own completion too, so this tool cannot return — let
        // alone report success — while it still holds the user's input control.
        detach.abort(new Error('wsl-term detached'))
        if (iterator !== null && typeof iterator.return === 'function') {
          try {
            // Bounded: a transport that ignores the abort would otherwise hold the call open
            // far past `waitMs`, and the result is already decided by then.
            await Promise.race([
              Promise.resolve(iterator.return()).then(() => undefined, () => undefined),
              new Promise((resolve) => { setTimeout(resolve, DETACH_GRACE_MS) }),
            ])
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
      // No start marker at all: nothing this call could report. The likeliest reason is that
      // this shell no longer has the helper (a new shell inside the same terminal, or a manual
      // `unset -f`) — but a shell still busy with an earlier command reads the same way, so the
      // message says both and the next call defines the helper again.
      const helperMissing = submitted && !captured.includes(START_PREFIX)
      if (helperMissing) helperReady.delete(info.id)
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
