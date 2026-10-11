// Pure helpers for `wsl-term`, which drives the DSH session's own terminal.
//
// That terminal is a headless xterm living in the HOST process, and the only way
// to look at it is a serialized screen (`follow`'s first frame) plus raw output
// chunks. Everything that turns those bytes into something a caller can read
// belongs here, so it can be tested without a live terminal.
//
// Measured on DSH 0.2.0 (`@deepseek-ai/dsh-api-terminal-controller`): `follow`
// yields `{type:'snapshot', screen, info}`, then `{type:'output', data}`, then
// `{type:'state', info}`; `serialize()` is called with no options, so the screen
// is the VIEWPORT (`@xterm/addon-serialize` scrollback defaults to 0) — not the
// full history. Anything before the attachment is therefore only visible if it
// still fits on screen.

/**
 * Escape sequences a serialized screen or a raw output chunk carries.
 *
 * Covers CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`) and the two-character
 * escapes, then drops the remaining control bytes except tab and newline.
 */
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** A path the Linux side cannot use as a working directory. */
const WINDOWS_PATH = /^[A-Za-z]:[\\/]|^\\\\/

/**
 * Describe the directory the controller reports for a terminal.
 *
 * Measured: this field is the SESSION's workspace as the host knows it, so on
 * Windows it is a Windows path (`D:\project`) — and a WSL shell launched with it
 * ignores it and starts in its own home. Printing it as a plain `cwd` implies the
 * shell is somewhere it is not, so the label says whose directory it is and the
 * caveat says what the shell did with it.
 * @param {unknown} cwd - `WebTerminalInfo.cwd`.
 * @returns one line naming the session workspace.
 */
export function describeSessionCwd(cwd) {
  const value = typeof cwd === 'string' && cwd.length > 0 ? cwd : '(unknown)'
  if (!WINDOWS_PATH.test(value)) return `session workspace: ${value}`
  return `session workspace: ${value} (a Windows path — a shell in this session starts in its own home, `
    + "such as /home/<user>, unless the panel's WSL 终端启动路径 is set)"
}

/**
 * Why a terminal this tool opened may not be visible as a sidebar tab.
 *
 * Read from the client half: the sidebar's tabs come from the app's layout owner
 * (`retainTabs`), every terminal view is mounted per (session, tabId), and the only
 * path a Host-side terminal has into the UI is the layout owner calling
 * `recover(sessionId)`. Nothing on the Host side can add a tab, so an opened
 * terminal is a real shell for this session that the sidebar may never list.
 */
export const OPENED_TERMINAL_NOTE =
  "opened by this tool for this session; the sidebar's tabs belong to the app layout, so it may not appear there"

/**
 * What the user sees in their own terminal while and after this tool works.
 *
 * Measured on a real sidebar terminal: while the tool is attached the view shows
 * 「此页面当前只读」 with a 「接管输入」 button, and after the tool detaches the control
 * slot is EMPTY rather than handed back to the attachment it displaced — the
 * platform has no "give it back to that attachment" call. So the user must click
 * 接管输入 to type again, and the model has to say so instead of leaving them in front
 * of a terminal that ignores their keystrokes.
 */
export const INPUT_HANDOVER_NOTE =
  "note: attaching took this terminal's input control, so the user's view is read-only until they click 接管输入 — "
  + 'tell them that if they are watching this terminal'

/**
 * Clip long output from the end that matters.
 *
 * Build and synthesis logs put the point at the bottom (the summary, the error), so
 * a head-only clip throws away exactly the part a caller asked for. Measured need: a
 * 60 492-character `make` output was reduced to its first 20 000 characters, which
 * held the compiler churn and none of the result.
 * @param {unknown} text - full text.
 * @param {number} limit - characters to keep, counted from the end.
 * @returns the tail, prefixed with what was left out.
 */
export function clipTail(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const omitted = value.length - limit
  const noun = omitted === 1 ? 'character' : 'characters'
  return `<output clipped: ${omitted} earlier ${noun} omitted; the file named below holds all of it>\n`
    + value.slice(omitted)
}

/**
 * One line telling the caller where the complete output went.
 * @param {{ locator?: unknown, bytes?: unknown, retrievalHint?: unknown }} ref - a `SpillRef`.
 * @returns a single line, or an empty string when there is nothing to report.
 */
export function spillLine(ref) {
  const locator = typeof ref?.locator === 'string' && ref.locator.length > 0 ? ref.locator : null
  if (locator === null) return ''
  const bytes = typeof ref?.bytes === 'number' ? ` (${ref.bytes} bytes)` : ''
  const hint = typeof ref?.retrievalHint === 'string' && ref.retrievalHint.length > 0 ? ` — ${ref.retrievalHint}` : ''
  return `full output${bytes}: ${locator}${hint}`
}

/**
 * Strip terminal control sequences so the text can be read as text.
 * @param {unknown} text - serialized screen or raw output.
 * @returns plain text with `\r\n`/`\r` normalized to `\n`.
 */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_PATTERN, '')
}

/**
 * Two marker strings identifying one wrapped command's output.
 *
 * A nonce keeps a command that itself echoes something marker-shaped from being
 * mistaken for the boundary.
 * @param {string} nonce - caller-supplied token.
 * @returns start and end markers (the end marker is followed by the exit code).
 */
export function markerPair(nonce) {
  return {
    start: `__DSH_TERM_START_${nonce}__`,
    end: `__DSH_TERM_END_${nonce}:`,
  }
}

/**
 * Wrap a command so its output and exit status are identifiable in the stream.
 *
 * The command is inserted verbatim, exactly as a user would type it, so the
 * shell parses it normally and `$?` reports its status. This assumes a
 * POSIX-style shell (`sh`, `bash`, `zsh`, `dash`, `ksh`); `printf '%s\n'` and
 * `"$?"` are the only constructs used. The markers are single-quoted, so a
 * command containing quotes cannot break them.
 * @param {string} command - the command line to run.
 * @param {{ start: string, end: string }} marker - pair from {@link markerPair}.
 * @returns the wrapped command line, without the trailing newline.
 */
export function wrapCommand(command, marker) {
  const body = String(command ?? '').trim()
  if (body.length === 0) throw new Error('wsl-term: run needs a non-empty command')
  return `printf '%s\\n' '${marker.start}'; ${body}; __dsh_term_rc=$?; printf '%s%s\\n' '${marker.end}' "$__dsh_term_rc"`
}

/**
 * Extract one wrapped command's output and exit code from a capture.
 * @param {string} text - captured terminal output (ANSI already stripped).
 * @param {{ start: string, end: string }} marker - pair used by {@link wrapCommand}.
 * @returns `{ output, exitCode, complete }`; `complete` is false while the end
 * marker has not arrived, and `output` is then `null`.
 */
export function extractCommand(text, marker) {
  const haystack = String(text ?? '')
  const end = haystack.lastIndexOf(marker.end)
  if (end < 0) return { output: null, exitCode: null, complete: false }
  const status = /^(\d+)/.exec(haystack.slice(end + marker.end.length))
  if (status === null) return { output: null, exitCode: null, complete: false }
  const start = haystack.lastIndexOf(marker.start, end)
  const body = start < 0 ? haystack.slice(0, end) : haystack.slice(start + marker.start.length, end)
  return {
    output: body.replace(/^[\n]+/, '').replace(/[\n]+$/, ''),
    exitCode: Number(status[1]),
    complete: true,
  }
}

/**
 * Choose which terminal an action targets.
 *
 * `list` returns terminals in publication order, so the last running one is the
 * most recently created — the best guess when the caller names no id. The pick
 * is always reported back, because typing into the wrong shell is the failure
 * mode that matters here.
 * @param {Array<Record<string, unknown>>} infos - `terminalController.list()`.
 * @param {string} [id] - explicit terminal identity.
 * @returns the chosen info, or null when there is nothing to target.
 */
export function pickTerminal(infos, id) {
  const list = Array.isArray(infos) ? infos : []
  if (typeof id === 'string' && id.length > 0) return list.find((info) => info.id === id) ?? null
  const running = list.filter((info) => info.state === 'running')
  const pool = running.length > 0 ? running : list
  return pool.length === 0 ? null : pool[pool.length - 1]
}

/**
 * Candidate identities for a terminal this tool opens itself.
 *
 * `create` is idempotent for a live id, and a CLOSED id can never be created
 * again in the same session (`closedIds`), so the caller walks this list until
 * one allocation succeeds. The first name is stable, so a second call reuses the
 * terminal instead of opening another tab.
 * @param {Array<Record<string, unknown>>} infos - current terminals.
 * @returns candidate ids, most preferred first.
 */
export function autoTerminalIds(infos) {
  const taken = new Set((Array.isArray(infos) ? infos : []).map((info) => String(info.id)))
  const candidates = []
  for (let index = 1; index <= 9; index += 1) {
    const candidate = index === 1 ? 'dsh-agent' : `dsh-agent-${index}`
    if (!taken.has(candidate)) candidates.push(candidate)
  }
  return candidates
}

/**
 * Describe who currently owns the keyboard.
 *
 * `follow` gives the newest attachment exclusive input control and demotes the
 * older ones to read-only, which is why every action here releases its
 * attachment in a `finally`.
 * @param {Record<string, unknown>} info - terminal info from the controller.
 * @returns one line naming the input holder.
 */
export function inputLine(info) {
  const holder = info?.controllerId
  return typeof holder === 'string' && holder.length > 0
    ? `input: held by attachment ${holder} (a newer attachment takes it over)`
    : 'input: free'
}

/**
 * Render the terminal list.
 * @param {Array<Record<string, unknown>>} infos - `terminalController.list()`.
 * @param {string} [selfId] - the id this tool opened, if it opened one.
 * @returns one line per terminal.
 */
export function renderTerminals(infos, selfId) {
  const list = Array.isArray(infos) ? infos : []
  if (list.length === 0) {
    return ['no terminal is open in this session yet — `run`/`read` can open one, though the sidebar may not list it']
  }
  const lines = [`${list.length} terminal(s) in this session:`]
  for (const info of list) {
    const shell = info?.shell?.name ?? info?.shell?.path ?? 'unknown shell'
    const state = info?.state === 'running' ? 'running' : `${info?.state ?? 'unknown'}${info?.exitCode === null || info?.exitCode === undefined ? '' : ` (exit ${info.exitCode})`}`
    const mine = selfId !== undefined && info.id === selfId ? ' · opened by this tool' : ''
    lines.push(
      `- id=${info.id} "${info.title ?? ''}" ${shell} · session workspace ${info.cwd ?? '?'} · ${info.cols}x${info.rows} · ${state}${mine}`,
    )
    lines.push(`  ${inputLine(info)}`)
  }
  return lines
}
