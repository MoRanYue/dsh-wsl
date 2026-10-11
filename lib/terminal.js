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
    return ['no terminal is open in this session yet — `run`/`read` will open one (it appears in the sidebar)']
  }
  const lines = [`${list.length} terminal(s) in this session:`]
  for (const info of list) {
    const shell = info?.shell?.name ?? info?.shell?.path ?? 'unknown shell'
    const state = info?.state === 'running' ? 'running' : `${info?.state ?? 'unknown'}${info?.exitCode === null || info?.exitCode === undefined ? '' : ` (exit ${info.exitCode})`}`
    const mine = selfId !== undefined && info.id === selfId ? ' · opened by this tool' : ''
    lines.push(
      `- id=${info.id} "${info.title ?? ''}" ${shell} · cwd=${info.cwd ?? '?'} · ${info.cols}x${info.rows} · ${state}${mine}`,
    )
    lines.push(`  ${inputLine(info)}`)
  }
  return lines
}
