// Destructive-command guard.
//
// The guard is a safety net for a model that is about to do something
// irreversible — not a security boundary (the caller may always pass
// `allowDangerous: true`). It is therefore tuned to be deterministic and to
// err toward refusing, while still letting a read-only INVESTIGATION of the
// same tools run: `man fdisk` and `grep reboot /var/log/syslog` must work.

// `rm` is the one command whose flag spelling is genuinely open-ended:
// `rm -rf`, `rm -fr`, `rm -r -f`, `rm -R --force`, `rm --recursive --force`.
// A regex over the whole command missed the separated and long forms, so scan
// each `rm` invocation and collect its flags individually. The prefix and the
// trailing lookahead tolerate everything that can wrap a command word: quotes,
// backticks, `$(`/`)` command substitution, and a `\rm` escape.
const RM_INVOCATION = /(?:^|[\s;&|"'`(\\])(?:\S*\/)?rm(?=[\s"'`)}]|$)/g
const QUOTE_STRIP_RE = /^["'`]+|["'`]+$/g

// `$IFS` (and `${IFS}`) expands to whitespace, so `rm$IFS-rf` is the same
// command as `rm -rf`. Normalize it for MATCHING only; the command that runs is
// untouched, so the worst case is refusing an exotic but harmless literal.
const IFS_ESCAPE_RE = /\$\{?IFS\}?/g

// Literal quoting is how a command talks ABOUT a destructive one instead of
// doing it: `grep -rn "rm -rf" docs/` and `git commit -m "fix rm -r"` are reads
// and a commit message, and refusing them costs the caller a needless
// `allowDangerous`. Quoted spans are therefore blanked before the `rm` scan —
// EXCEPT in a segment that runs a shell script, where the quotes really do
// carry a command that executes (`bash -c "rm -rf /"`).
const LITERAL_QUOTE_RE = /"[^"]*"|'[^']*'/g

// The shells whose `-c` argument is a script this guard has to keep reading.
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'busybox'])

// Wrappers that run the word after them. The command-word walk skips them, so
// `sudo reboot` and `nice -n 19 reboot` are still judged at command position
// rather than on the wrapper's own name.
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'exec', 'nohup', 'nice', 'ionice', 'time', 'timeout', 'stdbuf',
  'setsid', 'env', 'xargs',
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
])

// Words after which a command runs, for the `rm` scan: `xargs rm -rf`,
// `find . -exec rm -rf {} +`, `$(which rm) -rf`, `sudo rm -r -f`, `{ rm -r x; }`.
// Without this test ANY `rm` token counted as an invocation, which refused
// `ls rm -r` and `npm rm -r foo` — neither of which runs `rm` at all.
const EXECUTORS = new Set([
  ...COMMAND_WRAPPERS, 'xargs', 'parallel', '-exec', 'which', 'type', 'eval',
  'do', 'then', 'else', '!', '{', '(',
])

// A block device, by the names Linux gives them. The redirect rule used to list
// only `sd|hd|nvme|mmcblk|vd|xvd|disk`, so `> /dev/mapper/vg-lv` and
// `> /dev/dm-0` — the ordinary LVM spellings — sailed through.
const DEVICE_NAMES = 'sd|hd|nvme|mmcblk|vd|xvd|disk|mapper|dm-|md|sr|loop|zram|ram'
const BLOCK_DEVICE_RE = new RegExp(`/dev/(?:${DEVICE_NAMES})`)

// A RECURSIVE delete is refused whether or not `-f` is present: with stdin on
// /dev/null nothing prompts, so `rm -r tree` deletes a whole tree silently —
// exactly what this guard exists to prevent. Requiring `-f` as well let
// `rm a -f; rm b -r` through, and `-f` only suppresses prompts anyway.
//
// An `rm` only counts at COMMAND POSITION (the start of a segment, or after an
// executor). `rm` as an argument is a mention, not an invocation.
export function rmIsDestructive(segment) {
    const scanned = runsShellScript(segment) ? segment : segment.replace(LITERAL_QUOTE_RE, ' ')
    RM_INVOCATION.lastIndex = 0
    let match
    while ((match = RM_INVOCATION.exec(scanned)) !== null) {
        if (!atCommandPosition(scanned, match.index)) continue
        for (const rawToken of scanned.slice(match.index + match[0].length).split(/\s+/)) {
            const token = rawToken.replace(QUOTE_STRIP_RE, '')
            if (token === '--') break
            if (token === '--recursive') return true
            else if (/^-[A-Za-z]+$/.test(token) && (token.includes('r') || token.includes('R'))) return true
        }
    }
    return false
}

/** Does this segment run a shell's `-c` script? Then its quotes carry commands. */
function runsShellScript(segment) {
    const quotedAt = segment.search(/["']/)
    const prefix = quotedAt === -1 ? segment : segment.slice(0, quotedAt)
    return prefix.split(/\s+/).some((token) => SHELLS.has(shellWord(token.replace(QUOTE_STRIP_RE, ''))))
}

/** `$(which` / `/usr/bin/sudo` / `{` reduced to the word a set can be asked about. */
function shellWord(token) {
    const withoutSubstitution = token.replace(/^\$\(+/, '').replace(/[){(]+$/g, '')
    return withoutSubstitution.slice(withoutSubstitution.lastIndexOf('/') + 1)
}

/**
 * Is the character at `index` the start of a command rather than an argument?
 *
 * True at the start of a segment, and when anything before it on the same
 * segment was an executor — `xargs -0 rm -rf`, `find . -exec rm -rf {} +`,
 * `$(which rm) -rf`. `ls rm -r` and `npm rm -r foo` have no executor, so their
 * `rm` is an argument and stays allowed.
 */
function atCommandPosition(text, index) {
    const before = text.slice(0, index).trim()
    if (before === '') return true
    return before.split(/\s+/).some((token) => {
        const word = shellWord(token.replace(QUOTE_STRIP_RE, ''))
        return word === '' || EXECUTORS.has(word)
    })
}

// A command line is a sequence of segments separated by `;`, `&`, `|` or a
// newline. Scanning the WHOLE line for dangerous keywords refused `man fdisk`
// and `grep reboot /var/log/syslog`, so each segment is evaluated separately
// and the device/power tools are matched at COMMAND POSITION — the first word,
// past the wrappers and `VAR=value` assignments that can precede it.
const SEGMENT_SPLIT_RE = /[;&|\n]+/
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The command word a segment invokes, with wrappers, their value options and
 * `VAR=value` assignments skipped, and the path removed.
 */
export function commandWord(segment) {
  const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0)
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
    if (ENV_ASSIGNMENT_RE.test(bare)) {
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

// Patterns that are dangerous wherever they appear, because they WRITE to a
// block device or fork-bomb the machine regardless of the command word.
const DESTRUCTIVE_PATTERNS = [
  // `(?:^|[^>])` rather than `[^>]`: a redirect at the very start of a command (`> /dev/sda`)
  // has no preceding character, and requiring one let exactly that form through.
  [new RegExp(`(?:^|[^>])\\s*>>?\\s*${BLOCK_DEVICE_RE.source}`), 'redirect onto a block device'],
  [/:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}\s*;\s*:/, 'fork bomb'],
]

function segmentReason(segment) {
  if (rmIsDestructive(segment)) return 'recursive delete (`rm -r`)'

  const word = commandWord(segment)
  if (word === null) return null
  if (POWER_TOOLS.has(word)) return `power control (\`${word}\`)`
  if (/^(?:mkfs|mke2fs)(\.\w+)?$/.test(word)) return 'mkfs (format a filesystem)'
  if (DISK_TOOLS.has(word)) return `disk tool (\`${word}\`)`
  if (word === 'dd' && /\bof=\s*\/dev\//.test(segment)) return 'dd onto a block device'
  if (word === 'systemctl' && /\b(poweroff|reboot|halt)\b/.test(segment)) return 'power control (systemctl)'
  // `find` is how a whole tree disappears without `rm`, and `-delete` is the
  // flag that does it (`find / -delete` removed a system).
  if (word === 'find' && /(?:^|\s)-delete(?:\s|$)/.test(segment)) return 'find -delete (deletes what it matches)'
  // `git clean` deletes untracked files and directories. `-n`/`--dry-run` only
  // reports, so the refusal keys on the flags that actually remove.
  if (word === 'git' && /\bclean\b/.test(segment)
    && (/(?:^|\s)-[A-Za-z]*[fdDxX][A-Za-z]*(?:\s|$)/.test(segment) || /(?:^|\s)--force(?:\s|$)/.test(segment))) {
    return 'git clean (deletes untracked files)'
  }
  // `truncate -s0 /dev/sda` zeroes a device's head, which is a format in practice.
  if (word === 'truncate' && BLOCK_DEVICE_RE.test(segment)) return 'truncate on a block device'
  return null
}

/**
 * @param command - the final (post-translation) command string.
 * @returns a human-readable reason when the command is destructive, else null.
 */
export function destructiveReason(command) {
  const scanned = command.replace(IFS_ESCAPE_RE, ' ')
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(scanned)) return reason
  }
  for (const segment of scanned.split(SEGMENT_SPLIT_RE)) {
    const reason = segmentReason(segment)
    if (reason !== null) return reason
  }
  return null
}
