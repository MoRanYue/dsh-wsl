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
 * Add one output frame to the capture, colour-free and bounded.
 *
 * Two measured reasons this is a helper rather than `captured += frame.data`:
 * re-running `stripAnsi` over the whole capture for every frame is quadratic, and a chatty
 * command (`yes`) keeps producing frames for the whole wait, so the capture needs a ceiling.
 * What is dropped is counted, never guessed at, so the caller can say the capture is partial.
 * @param {string} current - capture so far (already stripped).
 * @param {unknown} frame - the raw frame text.
 * @param {number} limit - maximum characters kept (the tail is what matters: markers and results).
 * @returns `{ text, dropped }` — the new capture and how many characters fell off its front.
 */
export function appendCapture(current, frame, limit) {
  const combined = `${String(current ?? '')}${stripAnsi(frame)}`
  if (combined.length <= limit) return { text: combined, dropped: 0 }
  const overflow = combined.length - limit
  return { text: combined.slice(overflow), dropped: overflow }
}

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
  // Slicing by UTF-16 units can start on the low half of a surrogate pair (an emoji or any
  // astral character straddling the boundary), which is not text: it would be JSON-encoded
  // as a lone surrogate. Drop it, so the tail begins on a character boundary.
  let tail = value.slice(omitted)
  const first = tail.charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1)
  return `<output clipped: ${omitted} earlier ${noun} omitted; the file named below holds all of it>\n`
    + tail
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

/** The shell helper every `run` goes through, and the markers it prints. */
export const HELPER_NAME = '__dsh_term_run'
export const START_PREFIX = '#DSH-START:'
export const END_PREFIX = '#DSH-END:'

/**
 * The one-line shell function that makes a command's output and exit status identifiable.
 *
 * Why a helper rather than wrapping each command inline: the wrapper is typed INTO the user's
 * terminal, so it is the line the user reads. Spelling the markers out around every command
 * made the command itself hard to find in its own terminal (the author's own complaint);
 * defining the helper once per terminal keeps each call to one short line —
 * `__dsh_term_run k3f9a2 'make syn'` — while the output between the markers and the exit code
 * are still exact. The definition is visible the one time it is sent, so what runs in that
 * shell stays auditable.
 *
 * The nonce is an ARGUMENT rather than something the shell invents, and that is deliberate:
 * the definition line is echoed into the same stream, so it contains the marker prefixes
 * verbatim. A parser that searched for a prefix would find that echo first and never see the
 * real marker — measured on the first live run of the shell-invented variant, which waited out
 * its whole deadline. Passing the nonce in makes the parser match one exact string, which no
 * echo can imitate.
 *
 * POSIX only: `printf` and `$?`/`$1`/`$2` exist in `sh`/`dash`/`bash`/`zsh`, and no
 * `local`/`$RANDOM` (which dash lacks) is used.
 *
 * @returns the definition line, without a trailing newline.
 */
export function helperDefinition() {
  return `${HELPER_NAME}() { printf '${START_PREFIX}%s\\n' "$1"; eval "$2"; __dsh_r=$?; `
    + `printf '${END_PREFIX}%s:%s\\n' "$1" "$__dsh_r"; }`
}

/**
 * One call to {@link HELPER_NAME}: the nonce, then the command single-quoted so the shell
 * hands it to the helper unchanged. A command containing a single quote is escaped the
 * standard way (`'\''`), which keeps the visible line readable for everything else.
 *
 * A command may not contain a newline: it is typed as ONE line, so a literal break would be
 * submitted early and the rest would run as a second command.
 * @param {string} command - the command line to run.
 * @param {string} nonce - the token this call's markers carry.
 * @returns the call line, without a trailing newline.
 */
export function helperCall(command, nonce) {
  const body = String(command ?? '').trim()
  if (body.length === 0) throw new Error('wsl-term: run needs a non-empty command')
  if (/[\r\n]/.test(body)) throw new Error('wsl-term: run needs a single command line (join steps with `;` or `&&`)')
  if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('wsl-term: a call needs a nonce')
  return `${HELPER_NAME} ${nonce} '${body.replaceAll("'", "'\\''")}'`
}

/**
 * Extract one helper call's output and exit code from a capture.
 *
 * Matched on the EXACT nonce the caller passed, so the echoed definition line — which contains
 * the marker prefixes — cannot be mistaken for a marker.
 * @param {string} text - captured terminal output (ANSI already stripped).
 * @param {string} nonce - the token {@link helperCall} was given.
 * @returns `{ output, exitCode, complete }`; `complete` is false while the end marker has not
 *   arrived, and `output` is then `null`.
 */
export function extractHelperResult(text, nonce) {
  const haystack = String(text ?? '')
  if (typeof nonce !== 'string' || nonce.length === 0) return { output: null, exitCode: null, complete: false }
  const startMarker = `${START_PREFIX}${nonce}`
  const startAt = haystack.indexOf(startMarker)
  if (startAt < 0) return { output: null, exitCode: null, complete: false }
  const endMarker = `${END_PREFIX}${nonce}:`
  const endAt = haystack.indexOf(endMarker, startAt)
  if (endAt < 0) return { output: null, exitCode: null, complete: false }
  const status = /^(\d+)/.exec(haystack.slice(endAt + endMarker.length))
  if (status === null) return { output: null, exitCode: null, complete: false }
  const body = haystack.slice(startAt + startMarker.length, endAt)
  return {
    output: body.replace(/^[\n]+/, '').replace(/[\n]+$/, ''),
    exitCode: Number(status[1]),
    complete: true,
  }
}

/**
 * Does this screen look like a shell that is ready to be typed into?
 *
 * A terminal created a moment ago is still starting: its first frames carry the launcher's own
 * warning and no prompt. Typing then loses the write — measured: the helper's definition line
 * vanished and the command came back "command not found" in a terminal this tool had just
 * opened.
 *
 * The input is STRIPPED here rather than trusted to be clean, because the screen this is asked
 * about arrives as the emulator's own serialization: its last line ends in an escape sequence
 * (`\u001b[K` and friends), which no prompt pattern ever matches. That mistake made every later
 * `run` in a terminal this tool created wait out its whole deadline without typing anything —
 * measured from a frame trace: one snapshot arrived, `ready` was false, nothing was written.
 *
 * @param {unknown} text - screen or captured output, escaped or not.
 * @returns true when the last non-empty line ends in a prompt character.
 */
export function looksReady(text) {
  const lines = stripAnsi(text).split('\n').map((line) => line.trimEnd())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    return /[#$%>❯]\s?$/.test(line)
  }
  return false
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
  // A closed id can never be created again in that Session, so the range must not stop at a
  // handful: a session that opens and releases its own terminal per subtask would run out.
  for (let index = 1; index <= 999; index += 1) {
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
