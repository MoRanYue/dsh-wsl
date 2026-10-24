// Destructive-command guard.
//
// The guard is a safety net for a model that is about to do something
// irreversible — not a security boundary (the caller may always pass
// `allowDangerous: true`). It is therefore tuned to be deterministic and to
// err toward refusing, while still letting a read-only INVESTIGATION of the
// same tools run: `man fdisk` and `grep reboot /var/log/syslog` must work.
//
// The scan is ONE pass over the command: a tokenizer marks which tokens sit at command
// position, and suffix tables answer "is there a recursive flag after this `rm`?" in O(1).
// The first version re-sliced the whole segment for every `rm` match, which is quadratic —
// measured at 18.1 s for a single 60 KB segment (`"rm "` repeated 20 000 times), blocking the
// host's event loop for the whole time. The result is also capped in length (see
// `MAX_GUARD_CHARS`), because a command nobody can read is not one to silently allow.

const QUOTE_STRIP_RE = /^["'`]+|["'`]+$/g

// `$IFS` (and `${IFS}`) expands to whitespace, so `rm$IFS-rf` is the same
// command as `rm -rf`. Normalize it for MATCHING only; the command that runs is
// untouched, so the worst case is refusing an exotic but harmless literal.
const IFS_ESCAPE_RE = /\$\{?IFS\}?/g

// Literal quoting is how a command talks ABOUT a destructive one instead of
// doing it: `grep -rn "rm -rf" docs/` and `git commit -m "fix rm -r"` are reads
// and a commit message, and refusing them costs the caller a needless
// `allowDangerous`. Quoted spans are therefore blanked before the scan — EXCEPT
// in a segment that runs a shell script, where the quotes really do carry a
// command that executes (`bash -c "rm -rf /"`, `eval "rm -rf /"`).
const LITERAL_QUOTE_RE = /"[^"]*"|'[^']*'/g

// The shells whose `-c` argument is a script this guard has to keep reading.
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'busybox'])
// Words whose quoted argument is CODE rather than text. `eval` belongs here: it executes its
// argument, so `eval "rm -rf /"` is the same destructive act spelled differently.
const SCRIPT_WORDS = new Set([...SHELLS, 'eval'])

// `echo "rm -rf /" | bash` executes the quoted text as a script even though there is no
// `-c`: when a pipeline feeds a shell, quotes in the SOURCE segment are code. The check is
// run over the whole command; it is deliberately conservative and only relaxes the
// command-position requirement for the destructive words (a rare, suspicious shape).
// The path part is `[\w.@+-]*` rather than `\S*`: the greedy any-character form backtracked
// over the rest of a 60 KB pipe run at every `|` (measured 1.15 s), and a shell path is a
// word anyway.
const PIPE_SHELL_RE = /\|\s*(?:(?:sudo|doas|env|command|exec|nohup|time|nice)\s+)*(?:[\w.@+-]*\/)?(?:bash|sh|dash|zsh|ksh|ash|busybox)\b/

// Wrappers that run the word after them. The command-word walk skips them, so
// `sudo reboot` and `nice -n 19 reboot` are still judged at command position
// rather than on the wrapper's own name. `runuser` is here because
// `runuser -u root -- rm -rf /` is a root `rm` with two extra words in front.
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'exec', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'stdbuf',
  'setsid', 'env', 'xargs', 'runuser',
  ...SHELLS,
])

// Wrappers that take a bare leading operand (a duration) before the command:
// `timeout 5 reboot`.
const DURATION_WRAPPERS = new Set(['timeout', 'nice', 'ionice'])

// Options that CONSUME the next token, listed per wrapper that has them.
//
// Reading the wrapper's option names is what makes `sudo -u root mkfs.ext4 …`
// visible: without it the walk stopped on `root` and reported no dangerous
// command at all. Only options that really take a value are listed — `sudo -i`
// and `sudo -s` are flags, and skipping a token for them would hide the command
// they precede. An option written with its value attached (`xargs -I{}`,
// `stdbuf -i0`) needs no entry: it is one token, so nothing is skipped.
const WRAPPER_VALUE_OPTIONS = new Map([
  ['sudo', new Set([
    '-u', '--user', '-g', '--group', '-C', '--close-from', '-h', '--host', '-r', '--role',
    '-t', '--type', '-U', '--other-user', '-D', '--chdir', '-p', '--prompt', '-R', '--chroot',
    '-T', '--command-timeout',
  ])],
  ['doas', new Set(['-u', '-C'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'])],
  ['xargs', new Set([
    '-I', '--replace', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars',
    '-d', '--delimiter', '-a', '--arg-file', '-E', '--eof', '-L', '--max-lines',
  ])],
  ['env', new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])],
  ['stdbuf', new Set(['-i', '-o', '-e', '--input', '--output', '--error'])],
  ['runuser', new Set([
    '-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell',
    '-w', '--whitelist-environment', '-c', '--command', '--session-command',
  ])],
])

// Words after which a command runs, for the `rm` scan: `xargs rm -rf`,
// `find . -exec rm -rf {} +`, `$(which rm) -rf`, `sudo rm -r -f`, `{ rm -r x; }`.
// Without this test ANY `rm` token counted as an invocation, which refused
// `ls rm -r` and `npm rm -r foo` — neither of which runs `rm` at all.
const EXECUTORS = new Set([
  ...COMMAND_WRAPPERS, 'xargs', 'parallel', '-exec', 'which', 'type', 'eval',
  'do', 'then', 'else', '!', '{', '(',
])

// A redirection's OPERATOR alone (`>`, `>>`, `>|`, `2>`, `&>`): the next token is its target,
// so it must be skipped without losing command position. `2>&1` and `>/dev/null` carry their
// target inside the token and are complete on their own.
const REDIRECT_OPERATOR_RE = /^(?:\d+|\*)?&?(?:>>?\|?|<<?-?)$/
const REDIRECT_PREFIX_RE = /^(?:\d+|\*)?&?(?:>>?\|?|<<?-?)/
// Forks with a redirection in front of the command: `2>/dev/null rm -r x` and
// `2>&1 rm -r x` both run the `rm`, and the old scanner never reached it because the
// `2>&1` fragment split the segment at `&`.

// A block device, by the names Linux gives them. The redirect rule used to list
// only `sd|hd|nvme|mmcblk|vd|xvd|disk`, so `> /dev/mapper/vg-lv` and
// `> /dev/dm-0` — the ordinary LVM spellings — sailed through.
const DEVICE_NAMES = 'sd|hd|nvme|mmcblk|vd|xvd|disk|mapper|dm-|md|sr|loop|zram|ram'
const BLOCK_DEVICE_RE = new RegExp(`/dev/(?:${DEVICE_NAMES})`)

// The largest command the scanner will look at. Past it the answer is "refuse": the text is
// too long for a human to review in the transcript either, and silently allowing it would
// turn the length cap into a bypass. 64 KiB is well over the 30 000-char argv limit.
export const MAX_GUARD_CHARS = 64 * 1024

// A RECURSIVE delete is refused whether or not `-f` is present: with stdin on
// /dev/null nothing prompts, so `rm -r tree` deletes a whole tree silently —
// exactly what this guard exists to prevent. Requiring `-f` as well let
// `rm a -f; rm b -r` through, and `-f` only suppresses prompts anyway.
const isRecursiveFlag = (text) => {
  const bare = text.replace(QUOTE_STRIP_RE, '')
  return bare === '--recursive' || (/^-[A-Za-z]+$/.test(bare) && (bare.includes('r') || bare.includes('R')))
}

/** Split one segment into whitespace-separated tokens, remembering where each starts. */
function tokenize(text) {
  const tokens = []
  let start = -1
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const space = code === 32 || code === 9 || code === 10 || code === 13
    if (space) {
      if (start !== -1) {
        tokens.push({ text: text.slice(start, index), start })
        start = -1
      }
    } else if (start === -1) {
      start = index
    }
  }
  if (start !== -1) tokens.push({ text: text.slice(start), start })
  return tokens
}

/** `$(which`, `/usr/bin/sudo`, `{`, `\rm` reduced to the word a set can be asked about. */
function shellWord(token) {
  const withoutSubstitution = token
    .replace(/^\\+/, '')
    .replace(/^\$\(+/, '')
    .replace(/[){(]+$/g, '')
  return withoutSubstitution.slice(withoutSubstitution.lastIndexOf('/') + 1)
}

/**
 * Does this segment run a shell's `-c` script (or `eval`)? Then its quotes carry commands.
 */
function runsShellScript(segment) {
  const quotedAt = segment.search(/["']/)
  const prefix = quotedAt === -1 ? segment : segment.slice(0, quotedAt)
  return prefix.split(/\s+/).some((token) => SCRIPT_WORDS.has(shellWord(token.replace(QUOTE_STRIP_RE, ''))))
}

/**
 * Is this segment's `rm` invocation destructive?
 *
 * One left-to-right pass tracks command position. `rm` is only an invocation at command
 * position (start of the segment, after a wrapper/executor, after a redirection); a
 * recursive flag ANYWHERE after it, before a `--`, makes it destructive. The flag lookup is
 * a precomputed suffix table, so the whole scan is linear in the segment length.
 *
 * In `pipedToShell` mode every `rm` token counts, because a pipeline into a shell executes
 * the quoted source text as code (`echo "rm -rf /" | bash`) and there is no command position
 * to speak of in the source command.
 *
 * @param segment - one command segment (already split on `;`, `&`, `|`, newline).
 * @param options.quotesAreCode - do NOT blank quoted spans.
 * @param options.pipedToShell - a pipeline feeds a shell; relax the position requirement.
 * @returns true when this segment recursively deletes.
 */
export function rmIsDestructive(segment, options = {}) {
  const scanned = options.quotesAreCode === true ? segment : segment.replace(LITERAL_QUOTE_RE, ' ')
  const tokens = tokenize(scanned)
  const count = tokens.length
  const nextFlag = new Array(count + 1).fill(-1)
  const nextEnd = new Array(count + 1).fill(-1)
  for (let index = count - 1; index >= 0; index -= 1) {
    nextFlag[index] = isRecursiveFlag(tokens[index].text) ? index : nextFlag[index + 1]
    nextEnd[index] = tokens[index].text.replace(QUOTE_STRIP_RE, '') === '--' ? index : nextEnd[index + 1]
  }
  // A recursive flag counts only when it precedes the first `--` after the invocation.
  const hasRecursiveFlagAfter = (index) => {
    const flagAt = nextFlag[index + 1]
    if (flagAt < 0) return false
    const endAt = nextEnd[index + 1]
    return endAt < 0 || flagAt < endAt
  }

  let expectCommand = true
  let wrapper = null
  let skipNext = false
  for (let index = 0; index < count; index += 1) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const raw = tokens[index].text
    const bare = raw.replace(QUOTE_STRIP_RE, '')
    if (expectCommand) {
      if (bare === '') continue
      if (REDIRECT_OPERATOR_RE.test(bare)) {
        skipNext = true
        continue
      }
      if (REDIRECT_PREFIX_RE.test(bare)) continue
      if (bare === '--') continue
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) continue
      const word = shellWord(bare)
      if (wrapper !== null && DURATION_WRAPPERS.has(wrapper) && /^\d+(?:\.\d+)?[smhd]?$/.test(bare)) continue
      if (word === '') continue
      if (COMMAND_WRAPPERS.has(word) || EXECUTORS.has(word)) {
        wrapper = COMMAND_WRAPPERS.has(word) ? word : null
        continue
      }
      if (word.startsWith('-')) {
        if (wrapper !== null && (WRAPPER_VALUE_OPTIONS.get(wrapper)?.has(word) ?? false)) skipNext = true
        continue
      }
      if (word === 'rm' && hasRecursiveFlagAfter(index)) return true
      // The command word was found; the rest are its arguments. An executor token among
      // those arguments reopens command position (handled below).
      expectCommand = false
      wrapper = null
      continue
    }
    // Argument position: only an executor reopens command position, and in piped-to-shell
    // mode any `rm` is judged because the source text itself is what runs.
    const word = shellWord(bare)
    if (options.pipedToShell === true && word === 'rm' && hasRecursiveFlagAfter(index)) return true
    if (word === '') continue
    if (EXECUTORS.has(word) || COMMAND_WRAPPERS.has(word)) {
      expectCommand = true
      wrapper = COMMAND_WRAPPERS.has(word) ? word : null
    }
  }
  return false
}

/**
 * The command word a segment invokes, with wrappers, their value options and
 * `VAR=value` assignments skipped, and the path removed.
 */
export function commandWord(segment) {
  const tokens = tokenize(segment).map((token) => token.text)
  let index = 0
  let wrapper = null
  let skipNextValue = false
  while (index < tokens.length) {
    const bare = tokens[index].replace(QUOTE_STRIP_RE, '')
    if (skipNextValue) {
      skipNextValue = false
      index += 1
      continue
    }
    if (bare === '--') {
      index += 1
      continue
    }
    if (COMMAND_WRAPPERS.has(bare)) {
      wrapper = bare
      index += 1
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare)) {
      index += 1
      continue
    }
    if (bare.startsWith('-')) {
      if (wrapper !== null && (WRAPPER_VALUE_OPTIONS.get(wrapper)?.has(bare) ?? false)) skipNextValue = true
      index += 1
      continue
    }
    // A bare operand straight after a wrapper that takes a duration: `timeout 5 reboot`.
    if (wrapper !== null && DURATION_WRAPPERS.has(wrapper) && /^\d+(?:\.\d+)?[smhd]?$/.test(bare)) {
      index += 1
      continue
    }
    break
  }
  const word = tokens[index]
  if (word === undefined) return null
  const bare = word.replace(QUOTE_STRIP_RE, '')
  return bare.slice(bare.lastIndexOf('/') + 1)
}

const POWER_TOOLS = new Set(['shutdown', 'poweroff', 'reboot', 'halt'])
const DISK_TOOLS = new Set(['mkswap', 'wipefs', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'parted', 'blkdiscard', 'shred'])
// `systemctl` acts on a VERB, not on the whole line: `systemctl status reboot.target` is a
// read, while `systemctl reboot` is a power control. Matching the verb is what keeps the
// read-only investigation allowed without letting the verb itself through.
const SYSTEMCTL_POWER_VERBS = new Set([
  'poweroff', 'reboot', 'halt', 'suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate',
  'kexec', 'soft-reboot', 'emergency', 'rescue',
])
const SYSTEMCTL_VALUE_OPTIONS = new Set([
  '-H', '--host', '-M', '--machine', '-t', '--type', '-p', '--property', '-o', '--output',
  '-n', '--lines', '--signal', '--state', '--kill-whom', '--job-mode', '--message',
])
// Options that only REPORT: `fdisk -l`, `parted -l`, `mkfs --help` are read-only invocations
// of an otherwise dangerous tool.
const READ_ONLY_OPTION_RE = /^(?:-l|--list|-h|--help|-V|--version)$/

/** The subcommand after `systemctl`, with its options (and their values) skipped. */
function systemctlVerb(segment) {
  const tokens = tokenize(segment).map((token) => token.text.replace(QUOTE_STRIP_RE, ''))
  const at = tokens.findIndex((token) => shellWord(token) === 'systemctl')
  if (at === -1) return null
  let skipNext = false
  for (let index = at + 1; index < tokens.length; index += 1) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const bare = tokens[index]
    if (bare === '--') continue
    if (bare.startsWith('-')) {
      if (SYSTEMCTL_VALUE_OPTIONS.has(bare)) skipNext = true
      continue
    }
    return shellWord(bare)
  }
  return null
}

/**
 * Is this `mkfs`/`fdisk`/`parted` invocation options-only (a help/list query)?
 * True only when every argument is an option AND at least one of them is a read-only flag.
 */
function onlyReadOnlyOptions(segment, word) {
  const tokens = tokenize(segment).map((token) => token.text.replace(QUOTE_STRIP_RE, ''))
  const at = tokens.findIndex((token) => shellWord(token) === word)
  if (at === -1) return false
  const rest = tokens.slice(at + 1)
  return rest.length > 0 && rest.every((token) => token.startsWith('-')) && rest.some((token) => READ_ONLY_OPTION_RE.test(token))
}

// Patterns that are dangerous wherever they appear, because they WRITE to a
// block device or fork-bomb the machine regardless of the command word.
const DESTRUCTIVE_PATTERNS = [
  // `(?:^|[^>])` rather than `[^>]`: a redirect at the very start of a command (`> /dev/sda`)
  // has no preceding character, and requiring one let exactly that form through. `>>?\|?`
  // also covers the `>|` clobber redirect.
  [new RegExp(`(?:^|[^>])\\s*>>?\\|?\\s*${BLOCK_DEVICE_RE.source}`), 'redirect onto a block device'],
  // The classic `:(){ :|:& };:` — bounded gaps, because three unbounded `[^\n]*` around
  // single-character literals backtrack quadratically on a long line of `|` (measured 263 ms
  // at 30 KB; the bounded form is linear in practice and still matches the real shape).
  [/:\s*\(\s*\)\s*\{[^\n]{0,200}\|[^\n]{0,200}&[^\n]{0,200}\}\s*;\s*:/, 'fork bomb'],
]

// `git clean` deletes untracked files; `-n`/`--dry-run` only reports.
const GIT_CLEAN_DRY_RUN_RE = /(?:^|\s)(?:-[A-Za-z]*n[A-Za-z]*|--dry-run)(?=\s|$)/

/**
 * Tools that are dangerous when a pipeline executes their quoted output. Used only in
 * `pipedToShell` mode, where there is no command position to judge.
 */
function relaxedToolReason(segment) {
  for (const token of tokenize(segment)) {
    const word = shellWord(token.text.replace(QUOTE_STRIP_RE, ''))
    if (word === '') continue
    if (POWER_TOOLS.has(word)) return `power control (\`${word}\`)`
    if (/^(?:mkfs|mke2fs)(\.\w+)?$/.test(word)) return 'mkfs (format a filesystem)'
    if (DISK_TOOLS.has(word)) return `disk tool (\`${word}\`)`
  }
  return null
}

function segmentReason(segment, options) {
  const quotedAsCode = options.pipedToShell === true || runsShellScript(segment)
  if (rmIsDestructive(segment, { quotesAreCode: quotedAsCode, pipedToShell: options.pipedToShell === true })) {
    return 'recursive delete (`rm -r`)'
  }
  if (options.pipedToShell === true) {
    const relaxed = relaxedToolReason(segment)
    if (relaxed !== null) return relaxed
  }

  const word = commandWord(segment)
  if (word === null) return null
  if (POWER_TOOLS.has(word)) return `power control (\`${word}\`)`
  if (/^(?:mkfs|mke2fs)(\.\w+)?$/.test(word)) {
    return onlyReadOnlyOptions(segment, word) ? null : 'mkfs (format a filesystem)'
  }
  if (DISK_TOOLS.has(word)) {
    // `fdisk -l` / `parted -l` are how a caller inspects a disk; refusing them forced an
    // `allowDangerous` for a read.
    if ((word === 'fdisk' || word === 'parted') && onlyReadOnlyOptions(segment, word)) return null
    return `disk tool (\`${word}\`)`
  }
  if (word === 'dd' && /\bof=\s*\/dev\//.test(segment)) return 'dd onto a block device'
  if (word === 'systemctl' && SYSTEMCTL_POWER_VERBS.has(systemctlVerb(segment))) return 'power control (systemctl)'
  // A command that opens a block device for WRITING: `tee /dev/sda`, `cp img /dev/sdb`.
  if ((word === 'tee' || word === 'cp' || word === 'mv' || word === 'install') && BLOCK_DEVICE_RE.test(segment)) {
    return 'write onto a block device'
  }
  // `find` is how a whole tree disappears without `rm`, and `-delete` is the
  // flag that does it (`find / -delete` removed a system).
  if (word === 'find' && /(?:^|\s)-delete(?:\s|$)/.test(segment)) return 'find -delete (deletes what it matches)'
  // `git clean` deletes untracked files and directories. `-n`/`--dry-run` only
  // reports, so the refusal keys on the flags that actually remove.
  if (word === 'git' && /\bclean\b/.test(segment)) {
    if (GIT_CLEAN_DRY_RUN_RE.test(segment)) return null
    if (/(?:^|\s)-[A-Za-z]*[fdDxX][A-Za-z]*(?:\s|$)/.test(segment) || /(?:^|\s)--force(?:\s|$)/.test(segment)) {
      return 'git clean (deletes untracked files)'
    }
  }
  // `truncate -s0 /dev/sda` zeroes a device's head, which is a format in practice.
  if (word === 'truncate' && BLOCK_DEVICE_RE.test(segment)) return 'truncate on a block device'
  return null
}

// A command line is a sequence of segments separated by `;`, `&`, `|` or a
// newline. Scanning the WHOLE line for dangerous keywords refused `man fdisk`
// and `grep reboot /var/log/syslog`, so each segment is evaluated separately
// and the device/power tools are matched at COMMAND POSITION — the first word,
// past the wrappers and `VAR=value` assignments that can precede it.
// An `&` that belongs to a redirection (`2>&1`, `&>`) is NOT a separator: splitting there is
// what used to hide `2>&1 rm -r x` from the scanner. A `&` run (`&&`) still splits.
const SEGMENT_SPLIT_RE = /(?<!>)[;&](?![>])|[|\n]+/

/**
 * @param command - the final (post-translation) command string.
 * @returns a human-readable reason when the command is destructive, else null.
 */
export function destructiveReason(command) {
  const text = String(command ?? '')
  if (text.length > MAX_GUARD_CHARS) {
    // Refuse rather than allow: an over-long command cannot be reviewed by the caller either,
    // and this keeps the length cap from becoming a bypass.
    return `command is longer than ${MAX_GUARD_CHARS} characters, too long to inspect safely`
  }
  const scanned = text.replace(IFS_ESCAPE_RE, ' ')
  const pipedToShell = PIPE_SHELL_RE.test(scanned)
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(scanned)) return reason
  }
  for (const segment of scanned.split(SEGMENT_SPLIT_RE)) {
    const reason = segmentReason(segment, { pipedToShell })
    if (reason !== null) return reason
  }
  return null
}
