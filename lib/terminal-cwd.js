// The sidebar terminal's startup directory — read and rewritten where it lives.
//
// The 新建终端 shell belongs to another plugin
// (`@deepseek-ai/dsh-api-terminal-controller`), so this plugin cannot reach it
// through its own settings row: only the profile's own patch layer can override that
// row. This module is the one place that reads and rewrites the override, and it
// deliberately touches exactly ONE line — the `args:` line of the
// `- id: terminal-controller` entry — because the patch file is the user's own
// hand-written composition, not this plugin's storage.
//
// Everything here is a pure function over text, so the rules are testable without a
// profile on disk; `index.js` owns the file I/O, the backup and the routes.
//
// `wsl.exe` takes the directory as `--cd <dir>`: a Linux path, `~`, or an absolute
// Windows path (both sides are translated). WHERE the flag sits matters — everything
// after `-e`/`--exec` is the command line handed to the shell, so `--cd` must come
// BEFORE it. That is why this module inserts the flag there instead of appending it.
//
// Why the arguments are rewritten as a whole rather than as a text substitution: the
// line is a YAML flow sequence, so a naive `replace('--cd', …)` would corrupt a path
// that merely contains the text, and removing a flag means removing its value too.
// Parsing it into tokens and rendering it back is the only way to be sure that what
// lands is still a valid, single-line sequence.

/** The row this module edits, and the flag it owns. */
export const TERMINAL_ROW_ID = 'terminal-controller'
export const CWD_FLAG = '--cd'

/** `wsl.exe` hands everything after one of these to the shell as the command line. */
const EXEC_FLAGS = new Set(['-e', '--exec'])

/**
 * A patch entry starts with a dash; its indentation decides the extent of the block it
 * opens. Entries are normally top-level, but an override nested under an `insert:` list
 * is still the same override, so the row is matched at ANY indentation and the block
 * ends at the next list item at the same or a shallower indent.
 */
const ENTRY_RE = /^([ \t]*)-(?:[ \t]|$)/
const ROW_RE = /^([ \t]*)-[ \t]+id:[ \t]*['"]?terminal-controller['"]?[ \t]*(?:#.*)?$/
const SHELL_RE = /^([ \t]*)shell:[ \t]*(?:#.*)?$/
const ARGS_RE = /^([ \t]*)args:[ \t]*(.*?)[ \t]*$/
const CONFIG_RE = /^([ \t]*)config:[ \t]*(?:#.*)?$/
const SCROLLBACK_RE = /^([ \t]*)scrollback:[ \t]*([^#]*?)[ \t]*(#.*)?$/

/** The history the sidebar terminal keeps, measured in the UI's own component. */
export const SCROLLBACK_KEY = 'scrollback'
/** Accepted range for `scrollback` rows. 0 means "keep no history". */
export const SCROLLBACK_MAX = 100_000

const NO_ROW_ERROR = '这个 profile 的 patch 里没有指向 WSL 的侧边栏终端（terminal-controller），没有可改的行'
const NO_SHELL_ERROR = '这一段里的 `shell:` 不是本插件能安全改写的写法（需要块式写法、`args:` 独占一行），未做修改'
const NO_ARGS_ERROR = '这一段里找不到单行的 `args:` 行，为避免改坏文件，未做修改'
const AMBIGUOUS_ARGS_ERROR = '这一段里有不止一处 `args:`，无法确定该改哪一行，未做修改'
const SHAPE_ERROR = '`args:` 那一行不是本插件能安全解析的写法，为避免改坏文件，未做修改'
const NO_CONFIG_ERROR = '这一段里没有块式写法的 `config:`，无法在其中加入设置，未做修改'
const AMBIGUOUS_SCROLLBACK_ERROR = '这一段里有不止一处同级的 `scrollback:`，无法确定该改哪一行，未做修改'
const SCROLLBACK_SHAPE_ERROR = '`scrollback:` 那一行不是本插件能安全解析的写法，为避免改坏文件，未做修改'

/**
 * Split patch text into logical lines plus each line's own terminator.
 *
 * The terminators are kept PER LINE rather than as one file-wide setting, because a
 * patch file can genuinely be mixed: measured on the author's own profile, 5 lines end
 * with CRLF and 37 with LF, written by different tools over time. Rewriting one line
 * must not normalize the other 41, or the user's diff shows the whole file as changed
 * and `verifyTerminalRewrite` below — correctly — refuses the write.
 */
export function splitPatchLines(text) {
  const parts = String(text).split(/(\r?\n)/)
  const lines = []
  const eols = []
  for (let index = 0; index < parts.length; index += 2) {
    lines.push(parts[index])
    eols.push(index + 1 < parts.length ? parts[index + 1] : '')
  }
  return { lines, eols }
}

/** Put patch text back together exactly the way `splitPatchLines` took it apart. */
export function joinPatchLines(lines, eols) {
  let text = ''
  for (let index = 0; index < lines.length; index += 1) text += lines[index] + (eols[index] ?? '')
  return text
}

/**
 * Check one directory typed into the panel.
 *
 * Rejected outright — because the value is rendered into a YAML scalar and then
 * handed to `wsl.exe` — are line breaks, quote characters and control characters. A
 * leading or trailing space is trimmed rather than refused (`  ` is how a user clears
 * the field); spaces INSIDE the value are legal and pass through, since `--cd` takes
 * one argument and the shell is spawned with an argv list, never through a shell.
 *
 * @returns `{ ok, value, error }` — `value` is the trimmed directory, `''` meaning
 *   "no `--cd` at all".
 */
export function validateTerminalCwd(raw) {
  if (typeof raw !== 'string') return { ok: false, value: '', error: 'path 必须是字符串' }
  if (/[\r\n]/.test(raw)) return { ok: false, value: '', error: '路径不能包含换行' }
  const value = raw.trim()
  if (value === '') return { ok: true, value: '', error: null }
  if (/['"]/.test(value)) return { ok: false, value: '', error: '路径不能包含引号' }
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, value: '', error: '路径不能包含控制字符' }
  return { ok: true, value, error: null }
}

/**
 * Find the `args:` line of the terminal row.
 *
 * The entry's extent is bounded by the next list item at the same or a shallower indent,
 * so an `args:` belonging to a LATER entry can never be mistaken for this one — while a
 * deeper list inside the row (a nested block sequence) does not cut the block short.
 *
 * The search is then anchored on the row's own block-style `shell:` line, because that is
 * where the schema puts the args this feature owns. An `args:` elsewhere in the block, or
 * a `shell:` written in flow style, is refused rather than guessed at.
 *
 * @returns `{ error }` on refusal, otherwise
 *   `{ error: null, lines, eols, index, indent, raw }`, where `raw` is the flow
 *   sequence text (still including its brackets).
 */
export function locateTerminalArgs(text) {
  const { lines, eols } = splitPatchLines(text)
  let row = -1
  let rowIndent = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (match !== null) {
      row = index
      rowIndent = match[1].length
      break
    }
  }
  if (row === -1) return { error: NO_ROW_ERROR }

  let end = lines.length
  for (let index = row + 1; index < lines.length; index += 1) {
    const entry = ENTRY_RE.exec(lines[index])
    if (entry !== null && entry[1].length <= rowIndent) {
      end = index
      break
    }
  }

  let shell = -1
  let shellIndent = 0
  for (let index = row + 1; index < end; index += 1) {
    const match = SHELL_RE.exec(lines[index])
    if (match !== null) {
      shell = index
      shellIndent = match[1].length
      break
    }
  }
  if (shell === -1) return { error: NO_SHELL_ERROR }

  const found = []
  for (let index = shell + 1; index < end; index += 1) {
    const match = ARGS_RE.exec(lines[index])
    // A sibling of `shell:` (or anything shallower) is not part of the shell mapping, so
    // only a line nested deeper can be the args this feature owns.
    if (match === null || match[1].length <= shellIndent) continue
    found.push({ index, indent: match[1], raw: match[2] })
  }
  if (found.length === 0) return { error: NO_ARGS_ERROR }
  if (found.length > 1) return { error: AMBIGUOUS_ARGS_ERROR }

  const only = found[0]
  return { error: null, lines, eols, index: only.index, indent: only.indent, raw: only.raw }
}

/**
 * Parse a single-line YAML flow sequence of scalars.
 *
 * This is a reader for the one shape this module writes and for the shape a user
 * writes by hand (`['-e', 'bash', '-l']`, `[ -d, Ubuntu-22.04 ]`, `[ "--cd", "C:\\me" ]`,
 * a trailing comment after the closing bracket). It returns `null` for anything else — a
 * block-style list, a nested sequence, an unbalanced bracket, a double-quoted escape it
 * does not decode — because refusing to touch an unrecognized line is always better than
 * rewriting it wrongly.
 *
 * @returns `{ tokens, tail }` — the scalars, plus any `# comment` that followed the
 *   closing bracket (kept so rewriting the line does not silently delete an
 *   annotation) — or `null` when the text is not a flow sequence.
 */
export function parseFlowSequence(raw) {
  const text = raw.trim()
  if (!text.startsWith('[')) return null
  const tokens = []
  let current = ''
  let quoted = false
  let quote = null
  // A token that carried quotes keeps its content verbatim; padding OUTSIDE those
  // quotes (`[ '-d', … ]`) is dropped, which is why the two cases are tracked apart.
  let quotedToken = false
  let pendingSpace = false
  const push = () => {
    tokens.push(quotedToken ? current : current.trim())
    current = ''
    quotedToken = false
    pendingSpace = false
  }
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (quote === "'" && char === "'" && text[index + 1] === "'") {
        current += "'"
        index += 1
        continue
      }
      if (char === quote) {
        quoted = false
        continue
      }
      if (quote === '"' && char === '\\') {
        // YAML's double-quoted scalars have escapes. `\\` and `\"` are decoded; any other
        // one (`\n`, `\t`, `\uXXXX`, …) is refused rather than silently rewritten,
        // because re-rendering it as a single-quoted scalar would change the value: a
        // hand-written `"--cd", "C:\\Users\\me"` must not come back as two backslashes.
        const escaped = text[index + 1]
        if (escaped === '\\' || escaped === '"') {
          current += escaped
          index += 1
          continue
        }
        return null
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      // Whitespace before a quoted scalar is the sequence's own padding, not content.
      if (!quotedToken) current = ''
      pendingSpace = false
      quote = char
      quoted = true
      quotedToken = true
      continue
    }
    if (char === ']') {
      const tail = text.slice(index + 1).trim()
      if (tail !== '' && !tail.startsWith('#')) return null
      if (quotedToken || current.trim() !== '') push()
      return { tokens, tail }
    }
    if (char === ',') {
      if (quotedToken || current.trim() !== '') push()
      continue
    }
    if (char === ' ' || char === '\t') {
      // Inside a plain scalar this is content (trimmed later); after a quoted scalar it
      // is padding, remembered only in case more content follows in the same scalar.
      if (quotedToken) pendingSpace = true
      else current += char
      continue
    }
    if (pendingSpace) {
      current += ' '
      pendingSpace = false
    }
    current += char
  }
  return null
}

/** Render one token as a single-quoted YAML scalar (a quote inside is doubled). */
function quoteToken(token) {
  return `'${token.split("'").join("''")}'`
}

/**
 * Render the `args:` line, keeping the author's own bracket padding and any trailing
 * comment — this plugin owns one flag on that line, not its formatting.
 */
function renderArgsLine(indent, paddingSource, tail, tokens) {
  if (tokens.length === 0) return `${indent}args: []${tail === '' ? '' : `  ${tail}`}`
  const padded = /^\[[ \t]/.test(paddingSource.trim()) || /[ \t]\]$/.test(paddingSource.trim())
  const body = tokens.map(quoteToken).join(', ')
  const sequence = padded ? `[ ${body} ]` : `[${body}]`
  return `${indent}args: ${sequence}${tail === '' ? '' : `  ${tail}`}`
}

/** The `--cd` value carried by a token list, or `''`. */
function cwdOf(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === CWD_FLAG) return typeof tokens[index + 1] === 'string' ? tokens[index + 1] : ''
    if (tokens[index].startsWith(`${CWD_FLAG}=`)) return tokens[index].slice(CWD_FLAG.length + 1)
  }
  return ''
}

/** The same tokens without any `--cd` flag (and without the value it consumed). */
function withoutCwd(tokens) {
  const kept = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === CWD_FLAG) {
      index += 1
      continue
    }
    if (token.startsWith(`${CWD_FLAG}=`)) continue
    kept.push(token)
  }
  return kept
}

/**
 * Read what the patch currently says.
 *
 * `row` answers "is the terminal row here at all" — the panel needs that separately
 * from the value, because "no row" means the opt-in has not been applied yet, which is
 * a different instruction than "the value is empty".
 *
 * @returns `{ row, path, error }`: `path` is the current `--cd` value (`''` when the
 *   flag is absent), `error` explains a line that could not be read.
 */
export function readTerminalCwd(text) {
  const located = locateTerminalArgs(text)
  if (located.error !== null) {
    // A missing row is not an error for a reader — it is the documented opt-out.
    const missing = located.error === NO_ROW_ERROR
    return { row: !missing, path: '', error: missing ? null : located.error }
  }
  const parsed = parseFlowSequence(located.raw)
  if (parsed === null) return { row: true, path: '', error: SHAPE_ERROR }
  return { row: true, path: cwdOf(parsed.tokens), error: null }
}

/**
 * Return the patch text with `--cd` set to `rawPath` (or removed when it is empty).
 *
 * Pure: the caller decides whether to write. Every refusal returns the input text
 * untouched, so "rejected" can never mean "half-edited".
 *
 * @returns `{ ok, text, path, error }` — `path` is the resulting value on success.
 */
export function writeTerminalCwd(text, rawPath) {
  const wanted = validateTerminalCwd(rawPath)
  if (!wanted.ok) return { ok: false, text, path: '', error: wanted.error }
  const located = locateTerminalArgs(text)
  if (located.error !== null) return { ok: false, text, path: '', error: located.error }
  const parsed = parseFlowSequence(located.raw)
  if (parsed === null) return { ok: false, text, path: '', error: SHAPE_ERROR }

  const next = withoutCwd(parsed.tokens)
  if (wanted.value !== '') {
    // Everything after `-e`/`--exec` is the command line handed to the shell, so the
    // flag goes BEFORE it — appended, it would be read as an argument of `bash`.
    let at = next.length
    for (let index = 0; index < next.length; index += 1) {
      if (EXEC_FLAGS.has(next[index])) {
        at = index
        break
      }
    }
    next.splice(at, 0, CWD_FLAG, wanted.value)
  }

  const lines = located.lines.slice()
  lines[located.index] = renderArgsLine(located.indent, located.raw, parsed.tail, next)
  return { ok: true, text: joinPatchLines(lines, located.eols), path: wanted.value, error: null }
}

/**
 * Find the row and the block-style `config:` line that holds its settings.
 *
 * The UI's terminal component builds its xterm with `environment.scrollback`, and that
 * value is this row's `scrollback` setting — so the one place to raise how much history
 * a terminal keeps is a direct child of this `config:` block. A `config:` written in
 * flow style, or a row without one, is refused: this module only rewrites shapes it can
 * recognize.
 *
 * @returns `{ error }` on refusal, otherwise `{ error: null, lines, eols, configIndex, configIndent, end }`.
 */
export function locateTerminalConfig(text) {
  const { lines, eols } = splitPatchLines(text)
  let row = -1
  let rowIndent = 0
  for (let index = 0; index < lines.length; index += 1) {
    const match = ROW_RE.exec(lines[index])
    if (match !== null) {
      row = index
      rowIndent = match[1].length
      break
    }
  }
  if (row === -1) return { error: NO_ROW_ERROR }

  let end = lines.length
  for (let index = row + 1; index < lines.length; index += 1) {
    const entry = ENTRY_RE.exec(lines[index])
    if (entry !== null && entry[1].length <= rowIndent) {
      end = index
      break
    }
  }

  for (let index = row + 1; index < end; index += 1) {
    const match = CONFIG_RE.exec(lines[index])
    if (match !== null) {
      return { error: null, lines, eols, configIndex: index, configIndent: match[1].length, end }
    }
  }
  return { error: NO_CONFIG_ERROR }
}

/**
 * Check a history length typed into the panel.
 * @returns `{ ok, value, error }`; `value` is a number, or `null` for "leave it to the
 *   platform default" (the field was cleared).
 */
export function validateTerminalScrollback(raw) {
  if (raw === null || raw === undefined) return { ok: false, value: null, error: 'scrollback 必须是字符串或数字' }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) return { ok: false, value: null, error: '历史行数必须是整数' }
    if (raw < 0 || raw > SCROLLBACK_MAX) return { ok: false, value: null, error: `历史行数需在 0 到 ${SCROLLBACK_MAX} 之间` }
    return { ok: true, value: raw, error: null }
  }
  if (typeof raw !== 'string') return { ok: false, value: null, error: 'scrollback 必须是字符串或数字' }
  const text = raw.trim()
  if (text === '') return { ok: true, value: null, error: null }
  if (!/^\d+$/.test(text)) return { ok: false, value: null, error: '历史行数只能填数字' }
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value > SCROLLBACK_MAX) {
    return { ok: false, value: null, error: `历史行数需在 0 到 ${SCROLLBACK_MAX} 之间` }
  }
  return { ok: true, value, error: null }
}

/**
 * Read the row's current history length.
 * @returns `{ row, value, error }` — `value` is a number, `null` when the setting is
 *   absent (the platform default applies), and `error` explains a line that could not
 *   be read.
 */
export function readTerminalScrollback(text) {
  const located = locateTerminalConfig(text)
  if (located.error !== null) {
    const missing = located.error === NO_ROW_ERROR
    return { row: !missing, value: null, error: missing ? null : located.error }
  }
  const found = findScrollback(located)
  if (found.error !== null) return { row: true, value: null, error: found.error }
  if (found.index === -1) return { row: true, value: null, error: null }
  const raw = found.raw.trim()
  const parsed = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(parsed)) return { row: true, value: null, error: SCROLLBACK_SHAPE_ERROR }
  return { row: true, value: parsed, error: null }
}

/**
 * The row's own `scrollback:` line, if it has exactly one.
 *
 * "Ours" means a DIRECT child of `config:`, decided by the file's own indentation: the
 * first line inside the block sets the child indent, and only a `scrollback:` at exactly
 * that indent is this setting. A deeper one belongs to a nested block (say `shell:`'s own
 * key) and must be left alone — testing `indent > configIndent` alone would rewrite a
 * different plugin's meaning, which is the one mistake this module exists to avoid.
 *
 * @returns `{ index, indent, raw, comment, error }`; `index` is -1 when it is absent.
 */
function findScrollback(located) {
  const { lines, configIndex, configIndent, end } = located
  const indent = childIndent(located)
  const found = []
  for (let index = configIndex + 1; index < end; index += 1) {
    const match = SCROLLBACK_RE.exec(lines[index])
    if (match === null) continue
    if (match[1].length <= configIndent) continue
    if (match[1].length !== indent.length) continue
    found.push({ index, indent: match[1], raw: match[2], comment: match[3] ?? '' })
  }
  if (found.length === 0) return { index: -1, indent, raw: '', comment: '', error: null }
  if (found.length > 1) return { index: -1, indent, raw: '', comment: '', error: AMBIGUOUS_SCROLLBACK_ERROR }
  return { ...found[0], error: null }
}

/**
 * Return the patch text with the row's history length set (or removed when cleared).
 *
 * Pure, and it refuses rather than guesses: an unrecognized block leaves the text
 * untouched. Inserting uses the indentation of the `config:` block's existing children so
 * the new key lands beside them, not at some depth of this module's invention.
 *
 * @returns `{ ok, text, value, error }` — `value` is the resulting number or `null`.
 */
export function writeTerminalScrollback(text, raw) {
  const wanted = validateTerminalScrollback(raw)
  if (!wanted.ok) return { ok: false, text, value: null, error: wanted.error }
  const located = locateTerminalConfig(text)
  if (located.error !== null) return { ok: false, text, value: null, error: located.error }

  const found = findScrollback(located)
  if (found.error !== null) return { ok: false, text, value: null, error: found.error }

  const lines = located.lines.slice()
  const eols = located.eols.slice()
  if (wanted.value === null) {
    if (found.index === -1) return { ok: true, text, value: null, error: null }
    // Lines and terminators move together: dropping only the text would leave the file
    // one terminator short, which is exactly how an insert used to eat the final newline.
    lines.splice(found.index, 1)
    eols.splice(found.index, 1)
    return { ok: true, text: joinPatchLines(lines, eols), value: null, error: null }
  }

  if (found.index !== -1) {
    lines[found.index] = `${found.indent}${SCROLLBACK_KEY}: ${wanted.value}${found.comment === '' ? '' : ` ${found.comment}`}`
    return { ok: true, text: joinPatchLines(lines, eols), value: wanted.value, error: null }
  }

  const at = located.configIndex + 1
  lines.splice(at, 0, `${childIndent(located)}${SCROLLBACK_KEY}: ${wanted.value}`)
  eols.splice(at, 0, terminatorFor(eols, at))
  return { ok: true, text: joinPatchLines(lines, eols), value: wanted.value, error: null }
}

/**
 * The terminator a newly inserted line should use.
 *
 * The patch can be mixed (measured on the author's own profile: some lines CRLF, most
 * LF), so the new line copies the style of the line above it, falling back to the next
 * terminator that exists and finally to LF. Copying it is what keeps the file's own
 * ending pattern intact instead of normalizing the user's file.
 */
function terminatorFor(eols, at) {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (eols[index] !== '') return eols[index]
  }
  for (let index = at; index < eols.length; index += 1) {
    if (eols[index] !== '') return eols[index]
  }
  return '\n'
}

/** The indentation the `config:` block's existing children use, or two spaces deeper. */
function childIndent(located) {
  const { lines, configIndex, configIndent, end } = located
  for (let index = configIndex + 1; index < end; index += 1) {
    const match = /^([ \t]*)\S/.exec(lines[index])
    if (match !== null && match[1].length > configIndent) return match[1]
  }
  return ' '.repeat(configIndent + 2)
}

/**
 * Check what actually landed on disk for a scrollback write.
 * @returns an explanation when the write must be undone, `null` when it is good.
 */
export function verifyTerminalScrollbackRewrite(before, after, expected) {
  const structural = structuralComplaint(before, after, 'scrollback 那一行')
  if (structural !== null) return structural
  const read = readTerminalScrollback(after)
  if (!read.row || read.error !== null) return '写入后读不回那一行 scrollback'
  if (read.value !== expected) return `写入后读回的历史行数是 ${JSON.stringify(read.value)}`
  return null
}

/**
 * Check what actually landed on disk, before the caller trusts it.
 *
 * The patch belongs to the user, so the write is only accepted when it is provably the
 * write that was intended: no BOM appeared, the line ending did not change, the line
 * count is identical, exactly ONE line differs, and reading the file back yields the
 * requested directory. Anything else and the caller restores the previous content.
 *
 * @returns an explanation when the write must be undone, `null` when it is good.
 */
export function verifyTerminalRewrite(before, after, expected) {
  const structural = structuralComplaint(before, after, 'args 那一行')
  if (structural !== null) return structural
  const read = readTerminalCwd(after)
  if (!read.row || read.error !== null) return '写入后读不回那一行 args'
  if (read.path !== expected) return `写入后读回的启动路径是 ${JSON.stringify(read.path)}`
  return null
}

/** The checks both properties share: nothing else may move in the user's file. */
function structuralComplaint(before, after, what) {
  if (typeof after !== 'string' || after === '') return '写入后文件是空的'
  if (after.startsWith('\uFEFF')) return '写入后文件开头出现了 BOM'
  const previous = splitPatchLines(before)
  const current = splitPatchLines(after)
  // A replacement keeps the arrays the same length and changes exactly one entry; adding
  // or removing a key is the same operation with one entry inserted or dropped, which
  // shifts every line after it. Comparing position by position would call that "five
  // lines changed" and refuse a legitimate write, so the insertion/deletion shape is
  // recognized explicitly — and the terminators must shift with it, or the file's own
  // ending is being rewritten by accident.
  if (previous.lines.length === current.lines.length) {
    if (previous.eols.join('') !== current.eols.join('')) return '写入后换行符变了'
    let changed = 0
    for (let index = 0; index < previous.lines.length; index += 1) {
      if (previous.lines[index] !== current.lines[index]) changed += 1
    }
    if (changed !== 1) return `写入后改动了 ${changed} 行，应当只改 ${what}`
    return null
  }
  if (current.lines.length === previous.lines.length + 1) {
    return shiftedByOne(previous, current, what, 'inserted')
  }
  if (previous.lines.length === current.lines.length + 1) {
    return shiftedByOne(current, previous, what, 'removed')
  }
  return '写入后行数变了'
}

/**
 * Check "the longer text is the shorter one plus exactly one line".
 * @param {object} shorter - `{ lines, eols }` of the smaller text.
 * @param {object} longer - `{ lines, eols }` of the larger text.
 * @param {string} what - the property being written, for the complaint.
 * @param {string} verb - `inserted` or `removed`, for the complaint.
 * @returns `null` when the shape holds, otherwise the complaint.
 */
function shiftedByOne(shorter, longer, what, verb) {
  let at = 0
  while (at < shorter.lines.length && shorter.lines[at] === longer.lines[at]) at += 1
  const tailMatches = longer.lines.slice(at + 1).join('\n') === shorter.lines.slice(at).join('\n')
  if (!tailMatches) return `写入后不止一处改动，应当只${verb === 'inserted' ? '新增' : '删除'} ${what}`
  const eolsShifted = longer.eols.slice(at + 1).join('') === shorter.eols.slice(at).join('')
  if (!eolsShifted) return '写入后换行符变了'
  return null
}

/**
 * Decide what to do with what is on disk after a write.
 *
 * - `ok`       — the write is exactly the one that was intended.
 * - `conflict` — the file is no longer our text: something else wrote to it after us, and
 *                that version is NEWER, so restoring would destroy it. Leave it alone and
 *                say so; the caller must not "fix" somebody else's work.
 * - `undo`     — our own write landed wrong (or could not be read back), so the previous
 *                content is restored from the caller's copy.
 *
 * A conflict is inherently a race and is not reachable from a unit test of the file
 * system; keeping it a pure decision is what makes the rule visible and testable.
 *
 * @returns `{ verdict, error }`; `error` explains a `conflict` or an `undo`.
 */
export function reviewTerminalWrite(previousText, onDiskText, intendedText, expected, verify = verifyTerminalRewrite) {
  if (typeof onDiskText !== 'string' || onDiskText === '') {
    return { verdict: 'undo', error: '写入后读不回 profile patch' }
  }
  if (onDiskText !== intendedText) {
    return { verdict: 'conflict', error: '写入后文件又被其他程序改过，未自动还原，请人工确认' }
  }
  const complaint = verify(previousText, onDiskText, expected)
  if (complaint !== null) return { verdict: 'undo', error: complaint }
  return { verdict: 'ok', error: null }
}
