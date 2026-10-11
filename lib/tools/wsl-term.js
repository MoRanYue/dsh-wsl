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
  autoTerminalIds,
  clipTail,
  describeSessionCwd,
  extractCommand,
  INPUT_HANDOVER_NOTE,
  inputLine,
  markerPair,
  OPENED_TERMINAL_NOTE,
  pickTerminal,
  renderTerminals,
  spillLine,
  stripAnsi,
  wrapCommand,
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

      // Everything below acts on one terminal. Opening one is the documented
      // fallback when the session has none — it shows up in the sidebar, so the
      // user can watch (and take over) what the model is doing.
      let opened = false
      let info = pickTerminal(listTerminals(), id)
      if (info === null && id !== undefined) {
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

      if (action === 'close') {
        // Deliberately needs an explicit id: closing the terminal the user is
        // looking at is not something to do by guessing.
        const target = id !== undefined ? info : null
        if (target === null) throw new Error('wsl-term: close needs an explicit `id` (use action "list")')
        await controller.close(agent, target.id)
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
      let exitInfo = null
      let timedOut = false
      let wrote = null
      const marker = action === 'run' ? markerPair(randomUUID().replaceAll('-', '').slice(0, 12)) : null

      // Validate before attaching, so a bad call never takes the keyboard.
      if (action === 'run') wrapCommand(args?.command, marker)
      if (action === 'input' && (typeof args?.data !== 'string' || args.data.length === 0)) {
        throw new Error('wsl-term: input needs non-empty `data`')
      }

      let iterator = null
      try {
        const frames = controller.follow(agent, info.id, attachmentId, detach.signal)
        iterator = frames[Symbol.asyncIterator]()
        const deadline = Date.now() + waitMs
        let submitted = false
        while (true) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            timedOut = true
            break
          }
          const step = await withTimeout(iterator.next(), remaining)
          if (step === TIMEOUT) {
            timedOut = true
            break
          }
          if (step.done) break
          const frame = step.value
          if (frame?.type === 'snapshot') {
            snapshot = frame.screen
            // The snapshot proves we are attached and holding the input control,
            // so the first write happens here rather than before the loop.
            if (!submitted && action === 'run') {
              await controller.write(agent, info.id, attachmentId, `\u0015${wrapCommand(args.command, marker)}\r`)
              submitted = true
            } else if (!submitted && action === 'input') {
              await controller.write(agent, info.id, attachmentId, args.submit === true ? `${args.data}\r` : args.data)
              submitted = true
            } else if (!submitted && action === 'interrupt') {
              await controller.write(agent, info.id, attachmentId, '\u0003')
              submitted = true
            }
            if (action === 'interrupt') break
            continue
          }
          if (frame?.type === 'output') {
            captured += frame.data
            if (marker !== null && extractCommand(stripAnsi(captured), marker).complete) break
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
            await iterator.return()
          } catch {
            // Detaching already succeeded; a generator teardown error is not the
            // caller's problem and must not replace the real result.
          }
        }
      }

      if (action === 'interrupt') {
        return { summary: [...header, 'sent Ctrl-C (SIGINT).'].join('\n') }
      }
      if (action === 'input') {
        return {
          summary: [...header, `sent ${JSON.stringify(args.data)}${args.submit === true ? ' with Enter' : ''}.`].join('\n'),
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
      const extracted = marker === null ? null : extractCommand(stripAnsi(captured), marker)
      if (extracted !== null && extracted.complete) {
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
        ? await renderBody({ agent, label: 'run-output', text: stripAnsi(captured) })
        : '(no output captured)'
      return {
        summary: [
          ...header,
          `$ ${String(args.command).trim()}`,
          timedOut ? `(still running after ${waitMs} ms; the command was typed but did not report an exit code)` : '(no completion marker was seen)',
          capturedBody,
          'The command may still be running in that terminal — `interrupt` sends Ctrl-C.',
        ].join('\n'),
      }
    },
    presentCall: () => ({ card: 'terminal', title: 'Work in the session terminal' }),
  }
}
