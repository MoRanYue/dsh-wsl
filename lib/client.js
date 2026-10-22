// dsh-wsl-tool, browser half.
//
// This file is a PLAIN hand-written bundle, exactly like the ones DSH ships: no
// build step, no `import`/`export` keywords, no JSX, no TypeScript. The page
// loads it as a script, the module loader below hands it a `require`, and the
// only two modules it may ask for are React and the client UI primitives.
//
// What it contributes:
//   - one rail entry in the left sidebar (`sidebar.panellist`, a list seat), and
//   - the panel behind that entry (`main`, a keyed seat under the same id),
//     whose switches edit this plugin's own Host configuration row.
//
// The Host half reads its settings ONCE per mount (see `lib/config.js`), so a
// switch here changes the documented file/profile configuration; it does not
// reconfigure a running session. The panel says so in one line instead of
// pretending otherwise.
//
// Layout facts this file depends on (all verified against the shipped client):
//   - `sidebar.panellist` entries carry `id`, `order` and `label`, and render
//     their own icon (there is no icon field).
//   - `main` is keyed by that same id, and its `inject` callback supplies extra
//     props to the panel component.
//   - `ctx.configForms.get(rowId)` returns a scope with
//     `getSnapshot()` / `subscribe(listener)` / `mutate(ops, revision)`, where a
//     snapshot is `{ status, value, base, user, writable, revision }` and one op
//     is `{ op: 'set', path, value }` or `{ op: 'unset', path }`.

window.__ModuleLoader__.load({
  id: 'dsh-wsl-tool',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /**
     * Panel identity. The layout pairs one `sidebar.panellist` entry with the
     * `main` entry registered under the same key, so these two must agree; the
     * rail entry's `label` is the visible text, the accessible name and the
     * collapsed tooltip.
     */
    const PANEL_ID = 'dsh-wsl'

    /**
     * Loader row id of this bundle's Host half, read from our own
     * `cordis.patch.yml`. `configForms.get` addresses a Host configuration entry
     * by that row id — not by the package name, because one package may be
     * composed as several rows under different ids.
     */
    const CONFIG_ROW_ID = 'tool-wsl'

    /**
     * What to say when the Host never lists this plugin's configuration entry.
     *
     * That entry exists in the settings service only when the plugin exports a schema, and
     * the schema import is a soft one: on a Host without `@deepseek-ai/schemastery` — which
     * this plugin declares as an optional peer, so a bare install may not carry it — there
     * is no form at all and the namespace never arrives. Waiting forever tells the reader
     * nothing; naming the cause and what still works does.
     */
    const SCOPE_MISSING_NOTE = 'Host 未提供该插件的配置作用域：设置表单需要 `@deepseek-ai/schemastery`（DSH 通常自带）。'
      + '工具与「WSL 终端启动路径」不受影响。'

    /** How long "waiting for the scope" stays plausible before the note above replaces it. */
    const SCOPE_WAIT_MS = 8000

    /**
     * The Host routes this panel talks to, kept in step with `index.js`:
     *   - `info`: the plugin's own facts, for 「复制插件信息」 (read-only).
     *   - `terminal-cwd`: the sidebar terminal's startup directory, which lives in the
     *     profile's patch layer rather than in this plugin's configuration, so it is
     *     read and written here instead of through the settings scope.
     */
    /**
 * A terminal-subtask dock row, above the composer and beside the app's own dock entries.
 *
 * The row stays compact on purpose: how many subtasks this conversation has run, how many are
 * running, then one line per subtask — status, what the work was, what happened to its shell.
 * Clicking a line opens its detail: the terminal's full description, the result, and the
 * commands with their exit codes. Commands are what makes a row long, so they appear only when
 * asked for.
 *
 * Every failure is silent by design (no route, no session id, a rejected request): a dock row
 * that cannot read the log must not take the composer with it. A log that IS readable and
 * simply has nothing in it is a different state, and it says so in one faint line — a display
 * that only ever appears after the first subtask reads as missing.
 */
function WslSubtaskDock(props) {
  const [state, setState] = React.useState({ status: 'loading' })
  const [open, setOpen] = React.useState(null)
  const sessionId = props?.sessionId ?? props?.session?.id
  React.useEffect(() => {
    if (sessionId === undefined || sessionId === null) return undefined
    const fetcher = typeof fetch === 'function' ? fetch : undefined
    if (fetcher === undefined) return undefined
    let stopped = false
    let timer
    let delay = 2_000
    const read = () => {
      Promise.resolve(fetcher(SUBTASK_ROUTE, { headers: { accept: 'application/json' } }))
        .then((response) => (response !== undefined && response !== null && response.ok === true
          ? response.json()
          : undefined))
        .then((payload) => {
          if (stopped) return
          const mine = payload?.sessions?.[sessionId]
          if (mine === undefined || mine === null || (mine.entries ?? []).length === 0) {
            setState({ status: 'empty' })
            // Nothing to show: keep looking, but slowly. A row that only appeared after a
            // reload would be useless, and a fast poll with nothing to show is just noise.
            delay = 10_000
          } else {
            setState({ status: 'ready', total: mine.total, running: mine.running, entries: mine.entries })
            delay = 2_000
          }
          timer = setTimeout(read, delay)
        })
        .catch(() => {
          if (stopped) return
          // Not the same state as an empty log: nothing was read, so nothing can be said about
          // how many subtasks ran. Stay silent rather than claim there are none.
          setState({ status: 'unavailable' })
          timer = setTimeout(read, 10_000)
        })
    }
    read()
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
  }, [sessionId])

  if (sessionId === undefined || sessionId === null) return null
  // One faint line, no container: an empty record is not a row, but the reader has to know the
  // display exists before the first subtask lands.
  if (state.status === 'empty') {
    return React.createElement(
      'div',
      {
        style: {
          margin: '0 auto 4px',
          color: LABEL_TERTIARY,
          opacity: 0.55,
          fontSize: '11px',
          lineHeight: 1.25,
          textAlign: 'center',
          alignSelf: 'center',
          width: 'fit-content',
          maxWidth: '100%',
        },
      },
      '暂无子任务',
    )
  }
  if (state.status !== 'ready' || state.entries.length === 0) return null

  /** The terminal as it really is, on one line: what it is, where it is, how big it is. */
  const terminalLine = (entry) => {
    const info = entry.terminalInfo
    if (info === null || info === undefined) {
      return entry.terminal === 'closed' ? '终端已关闭（信息随之消失）' : '终端信息不可用'
    }
    const shell = info.shell === null
      ? null
      : (info.args.length > 0 ? `${info.shell} ${info.args.join(' ')}` : info.shell)
    const size = info.cols === null || info.rows === null ? null : `${info.cols}x${info.rows}`
    const name = info.title === null || info.title === '' ? '' : `「${info.title}」`
    return [
      `终端 ${info.id}${name}`,
      shell,
      info.cwd,
      size,
      info.state,
      entry.terminalCreated ? '工具自建' : '你自己开的',
      info.stale === true ? '（已关闭，这是最后一次看到的状态）' : null,
    ].filter((part) => part !== null && part !== undefined).join(' · ')
  }

  const monoStyle = {
    marginTop: '3px',
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: '11.5px',
    color: LABEL_SECONDARY,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  }

  const detail = (entry) => {
    const lines = entry.commands.map((command) => `$ ${command.command}`
      + (command.exitCode === null || command.exitCode === undefined ? '' : `   → ${command.exitCode}`))
    return React.createElement(
      'div',
      { style: { marginTop: '2px', paddingLeft: '10px' } },
      React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: '12px' } }, terminalLine(entry)),
      entry.result === null || entry.result === undefined
        ? null
        : React.createElement('div', { style: { color: LABEL_SECONDARY, fontSize: '12px', marginTop: '3px' } },
          `结果：${entry.result}`),
      lines.length === 0
        ? React.createElement('div', { style: { color: LABEL_TERTIARY, fontSize: '12px', marginTop: '3px' } },
          '（还没跑过命令）')
        : React.createElement('div', { style: monoStyle }, lines.join('\n')),
    )
  }

  const row = (entry, index) => {
    const running = entry.status !== 'done'
    const status = running
      ? '运行中'
      : entry.terminal === 'closed' ? '已结束·关闭' : '已结束·保留'
    const expanded = open === entry.id
    return React.createElement(
      'div',
      { key: entry.id, style: { marginTop: '2px' } },
      React.createElement(
        'div',
        {
          onClick: () => setOpen(expanded ? null : entry.id),
          style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px', cursor: 'pointer' },
        },
        React.createElement('span', {
          style: {
            color: LABEL_PRIMARY,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '46%',
          },
        }, `${running ? '●' : '✓'} ${entry.title}`),
        React.createElement('span', { style: { color: LABEL_TERTIARY, whiteSpace: 'nowrap' } }, status),
        React.createElement('span', { style: { color: LABEL_TERTIARY, marginLeft: 'auto', whiteSpace: 'nowrap' } },
          `${index === 0 ? `共 ${state.total} 个${state.running > 0 ? ` · 运行 ${state.running}` : ''} · ` : ''}${expanded ? '收起' : '详情'}`),
      ),
      expanded ? detail(entry) : null,
    )
  }

  return React.createElement(
    'div',
    {
      style: {
        margin: '0 auto 5px',
        padding: '3px 8px 4px',
        // Translucent so it reads as an overlay on the conversation, not as another card: the
        // composer below it is the only solid thing in this area.
        border: '1px solid rgba(128,128,140,.18)',
        borderRadius: '6px',
        background: 'rgba(128,128,140,.10)',
        color: LABEL_PRIMARY,
        fontSize: '11px',
        lineHeight: 1.25,
        // A pill that hugs its own text, centered like the composer card above which it sits.
        alignSelf: 'center',
        width: 'fit-content',
        maxWidth: '100%',
      },
    },
    state.entries.map(row),
  )
}

const INFO_ROUTE = '/dsh-wsl-tool/info'
/** The terminal subtasks this conversation has run, for the dock row above the composer. */
const SUBTASK_ROUTE = '/dsh-wsl-tool/subtasks'
    const TERMINAL_ROUTE = '/dsh-wsl-tool/terminal-cwd'
    /** WSL channel facts (port, host, shim presence) and its one install action. */
    const CHANNEL_STATE_ROUTE = '/dsh-wsl-tool/channel'
    const CHANNEL_INSTALL_ROUTE = '/dsh-wsl-tool/channel-install'
    /** The panel's create-a-session action for the channel picker. */
    const CHANNEL_NEW_ROUTE = '/dsh-wsl-tool/channel-new'

    /**
     * "3 小时前" for the picker's meta column. Returns '' for a missing timestamp, so a
     * row without one simply shows no time instead of "NaN 分钟前".
     */
    function relativeTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
      const delta = Date.now() - value
      if (delta < 60 * 1000) return '刚刚'
      const minutes = Math.round(delta / (60 * 1000))
      if (minutes < 60) return `${String(minutes)} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${String(hours)} 小时前`
      const days = Math.round(hours / 24)
      if (days < 30) return `${String(days)} 天前`
      return new Date(value).toLocaleDateString('zh-CN')
    }

    // Theme tokens, read as CSS custom properties so the panel follows the
    // active light/dark theme without importing any stylesheet. Each carries a
    // neutral fallback: an unknown token must not make text invisible.
    const LABEL_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const LABEL_SECONDARY = 'var(--dsw-alias-label-secondary, inherit)'
    const LABEL_TERTIARY = 'var(--dsw-alias-label-tertiary, inherit)'
    const BORDER_SOFT = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25))'
    const BORDER_BADGE = 'var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35))'
    const WARN_LABEL = 'var(--dsw-alias-state-warn-label, #b45309)'
    const LINK_LABEL = 'var(--dsw-alias-link, inherit)'
    const CODE_FILL = 'var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.12))'
    const RADIUS = 'var(--dsw-radius-xs, 4px)'

    /**
     * The switches, grouped into the two sections the panel renders.
     *
     * `path`   - path inside this plugin's configuration object (settings ops are
     *            path-addressed, so a nested section is one array, not a string).
     * `label`  - visible row text; also the switch's accessible name.
     * `hint`   - the one-line explanation under the label.
     * `when`   - the composed default for the row, used ONLY when the resolved
     *            value does not carry the field at all (an older Host half, or a
     *            field the Host schema does not declare). Reading a missing field
     *            as `false` would silently mislabel a default-on feature.
     * `danger` - marks a switch whose OFF state widens what the model may run.
     * `caution` - marks a switch whose ON state does: it authorises this plugin
     *            to do something the user should decide on purpose (install into
     *            the distribution, run a call as root).
     */
    const SECTIONS = [
      {
        id: 'tools',
        title: '工具',
        rows: [
          {
            path: ['tools', 'wsl'],
            label: 'wsl 命令执行',
            hint: '让模型在 WSL 里执行 Linux 命令并取回输出与退出码。每次调用都是全新的 shell，工作目录与环境变量不会保留。',
            when: true,
          },
          {
            path: ['tools', 'path'],
            label: 'wsl-path 路径转换',
            hint: '在 Windows 路径与 WSL 路径之间互转。',
            when: true,
          },
          {
            path: ['tools', 'env'],
            label: 'wsl-env 能力体检',
            hint: '查看发行版、内核、systemd、显卡、内存磁盘与挂载盘等环境信息。',
            when: true,
          },
          {
            path: ['tools', 'doctor'],
            label: 'wsl-doctor 项目体检',
            hint: '检查当前项目需要的工具在发行版里能不能用，并指出哪些命令其实来自 Windows。只查看，不修改。',
            when: true,
          },
          {
            path: ['tools', 'bootstrap'],
            label: 'wsl-bootstrap 安装工具链',
            hint: '在发行版里补装缺失的工具链（Node、pnpm、Python、编译工具等）。默认只给出计划，模型再确认一次才会真正安装；安装以 root 执行。',
            when: false,
            caution: true,
            cautionTitle: '打开需谨慎：允许模型在 WSL 里安装软件，安装以 root 执行，会改动发行版内的环境。默认只给出计划，需要模型再请求一次才会真正安装。',
          },
        ],
      },
      {
        id: 'behavior',
        title: '行为',
        rows: [
          {
            path: ['backgroundJobs'],
            label: '后台任务',
            hint: '长任务可以放到后台执行，完成后由模型读取结果，不必一直等待。',
            when: true,
          },
          {
            path: ['translatePaths'],
            label: '自动转换路径',
            hint: '命令里出现的 Windows 路径自动转换成 WSL 能使用的路径。',
            when: true,
          },
          {
            path: ['startInSessionWorkspace'],
            label: '默认跟随会话工作区',
            hint: '模型没有指定目录时，从当前会话的工作区开始执行（默认开启）。关闭后使用下方「默认工作目录」，该目录留空时使用 Linux 家目录。',
            when: true,
          },
          {
            path: ['dangerGuard'],
            label: '危险命令守卫',
            hint: '删除、分区、关机等危险命令必须由模型显式声明才能执行；关闭后模型可以直接执行这类命令。',
            when: true,
            danger: true,
          },
          {
            path: ['allowRoot'],
            label: '管理员模式（root）',
            hint: '允许模型以 root 身份执行命令（`wsl -u root`）。WSL 的 root 不需要密码，因此这项开关就是授权本身；每一次 root 执行都会在结果中标注。',
            when: false,
            caution: true,
            cautionTitle: '打开需谨慎：模型可以以 root 身份在 WSL 里执行命令，能在发行版内做任何改动。',
          },
        ],
      },
      {
        id: 'channel',
        title: 'WSL 终端里的 DSH 命令',
        rows: [
          {
            path: ['channelEnabled'],
            label: '启用 dsh 命令',
            hint: '在 WSL 终端里用 `dsh` 对 DSH 说话：消息进入你在上面选的那段会话，回复流式回到终端。对话本身仍显示在客户端里。',
            when: false,
            caution: true,
            cautionTitle: '开启后，本机的 WSL 终端可以把消息送进你选的会话。通道只监听 WSL 能到的地址，每个请求都要带本次启动生成的令牌。',
          },
        ],
      },
    ]

    /** The submission guide shown beside the copy button.
     *
     * It lives in the panel because "where does this go" is the question a copied
     * block raises at exactly that moment; SUPPORT.md is the long form of the same
     * list, with the repository for each kind of problem.
     */
    const GUIDE = [
      '标题写明现象，例如「[Bug] 后台任务在带 systemd 的发行版中报无属主」；模板会自动加 `[Bug]` 前缀。',
      '正文包含三段：现象（附原文）、预期结果、复现步骤。',
      '「补充」栏粘贴上面复制的内容：版本号、发行版与开关状态均在其中。',
      '提问与想法请走 Discussions；DSH 本体、市场界面与收录目录的问题各有对应仓库（见 `SUPPORT.md`）。',
      '提交前删除不宜公开的路径、主机名与密钥：Issue 是公开的。',
    ]

    /** A setting nobody can read yet; shaped like a scope snapshot so the panel
     *  can treat it uniformly. `status: 'unavailable'` is the platform's own word
     *  for "this Host does not serve that configuration entry". */
    const UNAVAILABLE_SNAPSHOT = {
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      writable: false,
      revision: undefined,
    }

    /**
     * No scope yet — the Host has not listed this namespace, or its `describe()`
     * round trip is still in flight.
     *
     * This is deliberately NOT the unavailable snapshot: a panel that reads "this
     * DSH does not provide the plugin's settings scope" while it is merely still
     * waiting sends whoever is debugging it after the wrong thing (measured: it
     * said exactly that for a namespace the Host was already serving, because the
     * form had been taken before the round trip settled).
     */
    const PENDING_SNAPSHOT = {
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      writable: false,
      revision: undefined,
    }

    // ---------------------------------------------------------------- helpers

    /** Read one path out of a possibly absent object, never throwing. */
    function readPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[step]
      }
      // A `.volatile()` field can arrive as a cosmokit cell rather than its value;
      // the platform's own form model hands out plain values, but unwrapping here
      // costs nothing and keeps a switch from rendering a cell object as "on".
      return cursor !== null && typeof cursor === 'object' && typeof cursor.get === 'function'
        ? cursor.get()
        : cursor
    }

    /**
     * Whether the USER layer itself carries this path — i.e. whether the value is
     * an override rather than inherited from the composition or the schema
     * default. Presence is what marks an override, not a value comparison: an
     * override that happens to equal the default is still an override.
     */
    function hasPath(target, path) {
      let cursor = target
      for (const step of path) {
        if (cursor === null || typeof cursor !== 'object') return false
        if (!Object.prototype.hasOwnProperty.call(cursor, step)) return false
        cursor = cursor[step]
      }
      return true
    }

    /**
     * Everything this panel knows about the Host configuration.
     *
     * Both the service and the row are optional, so every read is tolerant:
     * a missing `configForms`, a row this Host does not serve, and a scope whose
     * `getSnapshot` throws all end at `unavailable` instead of an exception in
     * the middle of a render.
     */
    function createConfigModel() {
      let served = false
      let scope
      let unsubscribe
      const listeners = new Set()

      const publish = () => {
        // Copy first: a listener may unsubscribe itself while being notified.
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-wsl-tool: a settings panel listener failed', error)
          }
        }
      }

      const read = () => {
        if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') {
          return PENDING_SNAPSHOT
        }
        try {
          const snapshot = scope.getSnapshot()
          return snapshot !== null && typeof snapshot === 'object' ? snapshot : UNAVAILABLE_SNAPSHOT
        } catch (error) {
          console.error('dsh-wsl-tool: reading the configuration scope failed', error)
          return UNAVAILABLE_SNAPSHOT
        }
      }

      return {
        /** Whether the `configForms` service was there at all. A service this DSH
         *  does not ship reads differently from a row it does not serve — and both
         *  read differently from a namespace that simply has not been listed yet. */
        hasService: () => served,
        /** Record that the service exists, before any scope is available. Without
         *  this, a namespace that has not been served yet reads as "this DSH has no
         *  configuration forms", which is a different (and wrong) diagnosis. */
        noteService: () => {
          served = true
        },
        /** Bind the scope once the service appears. */
        attach: (next) => {
          if (next === undefined || next === null) return
          served = true
          scope = next
          if (typeof scope.subscribe === 'function') {
            try {
              unsubscribe = scope.subscribe(publish)
            } catch (error) {
              console.error('dsh-wsl-tool: subscribing to the configuration scope failed', error)
            }
          }
          publish()
        },
        /** Release the scope subscription; the caller's effect owns the call. */
        detach: () => {
          if (typeof unsubscribe === 'function') {
            try {
              unsubscribe()
            } catch (error) {
              console.error('dsh-wsl-tool: releasing the configuration scope failed', error)
            }
          }
          unsubscribe = undefined
        },
        read,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /**
         * Submit exactly one path-addressed write against the revision read just
         * now, and answer whether the Host accepted it.
         *
         * The revision matters: the settings service refuses a write that was
         * composed against a value somebody else has already replaced, rather than
         * silently overwriting it. Its own settings form treats any falsy answer as
         * a refusal, so this panel does the same — `false` means "not saved", and
         * the panel words it instead of pretending the switch moved.
         */
        write: async (ops) => {
          const snapshot = read()
          if (scope === undefined || typeof scope.mutate !== 'function') return false
          if (snapshot.writable !== true) return false
          // One op or an ordered batch: the service applies a batch in one
          // revision-fenced write, which is what the panel's single "restore every
          // default" control uses.
          const batch = Array.isArray(ops) ? ops : [ops]
          if (batch.length === 0) return true
          try {
            const landed = await scope.mutate(batch, snapshot.revision)
            return Boolean(landed)
          } catch (error) {
            console.error('dsh-wsl-tool: writing the configuration failed', error)
            return false
          }
        },
      }
    }

    /** Stand-in model for a seat that somehow renders without injected props, so
     *  a missing prop shows the "not served" note instead of throwing. */
    const DETACHED_MODEL = createConfigModel()

    // ----------------------------------------------------------------- styles

    const PANEL_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      height: '100%',
      maxWidth: '760px',
      overflowY: 'auto',
      padding: '24px',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
    }
    const HEADER_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const TITLE_STYLE = { margin: 0, fontSize: '18px', fontWeight: 600, lineHeight: '26px' }
    const DESCRIPTION_STYLE = { margin: 0, color: LABEL_SECONDARY }
    const NOTE_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px' }
    const STACK_STYLE = { display: 'flex', flexDirection: 'column', gap: '24px' }
    const SECTION_STYLE = { display: 'flex', flexDirection: 'column', gap: '4px' }
    const SECTION_TITLE_STYLE = { margin: 0, fontSize: '14px', fontWeight: 500, lineHeight: '20px' }
    const ROWS_STYLE = { display: 'flex', flexDirection: 'column' }
    const ROW_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '14px 0',
      borderBottom: '0.5px solid ' + BORDER_SOFT,
    }
    const ROW_COPY_STYLE = { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }
    const ROW_LABEL_STYLE = { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }
    const ROW_ACTIONS_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }
    /** The panel's single override bar; `rowGap` keeps it readable above the rows. */
    const OVERRIDE_BAR_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      justifyContent: 'flex-end',
      padding: '6px 0',
    }
    const HINT_STYLE = { margin: 0, color: LABEL_TERTIARY, fontSize: '12px', lineHeight: '18px', maxWidth: '66ch' }
    /** One path field: the input and its single 保存, side by side. */
    const FIELD_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' }
    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: RADIUS,
      border: '1px solid ' + BORDER_SOFT,
      background: 'transparent',
      color: LABEL_PRIMARY,
      fontFamily: 'inherit',
      fontSize: '12.5px',
    }
    /** The submission guide beside the copy button: an ordered list, not prose. */
    const GUIDE_STYLE = {
      margin: 0,
      paddingLeft: '18px',
      color: LABEL_SECONDARY,
      fontSize: '12px',
      lineHeight: '18px',
      maxWidth: '72ch',
    }
    const GUIDE_ITEM_STYLE = { marginTop: '3px' }
    const BADGE_STYLE = {
      border: '0.5px solid ' + BORDER_BADGE,
      borderRadius: RADIUS,
      color: LABEL_SECONDARY,
      fontSize: '11px',
      lineHeight: '16px',
      padding: '1px 6px',
      whiteSpace: 'nowrap',
    }
    const DANGER_STYLE = {
      border: '0.5px solid currentColor',
      borderRadius: RADIUS,
      color: WARN_LABEL,
      fontSize: '11px',
      lineHeight: '16px',
      padding: '0 4px',
      whiteSpace: 'nowrap',
    }
    const RESET_STYLE = {
      background: 'none',
      border: 'none',
      color: LINK_LABEL,
      cursor: 'pointer',
      fontFamily: 'inherit',
      fontSize: '12px',
      fontWeight: 'inherit',
      padding: 0,
      textDecoration: 'underline',
    }
    const DEFINITION_ROW_STYLE = { display: 'flex', alignItems: 'baseline', gap: '12px' }
    const DEFINITION_LABEL_STYLE = { color: LABEL_SECONDARY, minWidth: '13em' }
    const DEFINITION_VALUE_STYLE = { color: LABEL_PRIMARY }
    const PRE_STYLE = {
      margin: 0,
      padding: '12px',
      background: CODE_FILL,
      borderRadius: RADIUS,
      // Body text, not the inline-code tint: this is a whole block a reader has to
      // read character by character (a path with backslashes, an argv list), and the
      // inline-code token is dimmed against the very fill it sits on.
      color: LABEL_PRIMARY,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12.5px',
      lineHeight: '19px',
      overflowX: 'auto',
      whiteSpace: 'pre',
    }

    // ------------------------------------------------------------ components

    /**
     * The rail icon. A `sidebar.panellist` entry draws its own glyph: an 18×18
     * terminal prompt in `currentColor`, so the layout's selected/hover colours
     * come through untouched.
     */
    function WslIcon() {
      return React.createElement(
        'svg',
        {
          width: 18,
          height: 18,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // The terminal frame, the prompt chevron, and the command line.
        React.createElement('path', {
          d: 'M3.5 4.5h13a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
        }),
        React.createElement('path', { d: 'M6.5 8.5 8.5 10.5 6.5 12.5' }),
        React.createElement('path', { d: 'M10.5 13h3' }),
      )
    }

    /** One read-only label/value line, used by the effective-defaults section. */
    function definitionRow(label, value) {
      return React.createElement(
        'div',
        { style: DEFINITION_ROW_STYLE },
        React.createElement('span', { style: DEFINITION_LABEL_STYLE }, label),
        React.createElement('span', { style: DEFINITION_VALUE_STYLE }, value),
      )
    }

    /** A section frame: a heading plus its body, which may be several nodes. */
    function section(key, title, ...children) {
      return React.createElement(
        'section',
        { key, style: SECTION_STYLE },
        React.createElement('h3', { style: SECTION_TITLE_STYLE }, title),
        ...children,
      )
    }

    /**
     * The panel behind the rail entry.
     *
     * It renders whatever the scope currently says — `ready`, still `loading`, or
     * `unavailable` — because a settings panel that throws or renders nothing on a
     * stripped composition is worse than one that explains itself. Reading goes
     * through the injected model so a service that appears later needs no remount.
     */
    function WslPanel(props) {
      const model = props !== null && props !== undefined && props.model !== undefined ? props.model : DETACHED_MODEL
      const [snapshot, setSnapshot] = React.useState(model.read())
      // `busy` is the path key of the write in flight; `refused` remembers that the
      // Host did not accept the last one, so the panel can say so.
      const [busy, setBusy] = React.useState(undefined)
      const [refused, setRefused] = React.useState(false)
      // Feedback copying: `ok` when the clipboard took it, `manual` when the browser
      // refused (no clipboard API, or no permission) so the text is shown to select.
      const [feedbackCopy, setFeedbackCopy] = React.useState(undefined)
      const [feedbackText, setFeedbackText] = React.useState('')
      const [selfInfo, setSelfInfo] = React.useState(undefined)
      // The sidebar terminal's startup directory: what the Host last reported, and the
      // outcome of the last write. It is NOT part of the settings scope (the terminal
      // belongs to another plugin), so it is read over its own route instead.
      const [terminal, setTerminal] = React.useState({
        status: 'loading',
        path: '',
        available: true,
        error: undefined,
      })
      const [terminalSave, setTerminalSave] = React.useState(undefined)
      // The field's draft is STATE, unlike the workdir field's closure below: this value
      // arrives ASYNCHRONOUSLY from the Host route, and an uncontrolled input would keep
      // the DOM text but lose it to the value of the re-render that the answer triggers.
      // `undefined` means "nothing typed yet", so the Host's value fills the box.
      const [terminalDraft, setTerminalDraft] = React.useState(undefined)
      // The same row also carries how much history its terminal keeps (`scrollback`), which
      // the app's terminal component reads through the Host's environment. Same route, same
      // rules: separate draft/save state, one control, one 保存, and the value arrives
      // asynchronously with the directory above.
      const [scrollback, setScrollback] = React.useState({
        status: 'loading',
        value: null,
        available: true,
        error: undefined,
      })
      const [scrollbackSave, setScrollbackSave] = React.useState(undefined)
      const [scrollbackDraft, setScrollbackDraft] = React.useState(undefined)
      // The workdir field's draft is state for the same reason, and for one more: the scope
      // snapshot is replaced by every switch toggle, so a closure-held draft would be lost
      // and the save would write the snapshot's value instead of the typed one.
      const [workdirDraft, setWorkdirDraft] = React.useState(undefined)
      // WSL 终端里的 dsh 命令：Host 报回的可选会话、通道状态、新建会话的草稿与安装结果。
      const [channelNewDraft, setChannelNewDraft] = React.useState('')
      const [channelInfo, setChannelInfo] = React.useState({
        status: 'loading',
        available: true,
        shim: false,
        port: null,
        host: null,
        error: undefined,
        sessions: [],
      })
      const [channelInstall, setChannelInstall] = React.useState(undefined)
      const [channelBusy, setChannelBusy] = React.useState(false)
      const [channelListBusy, setChannelListBusy] = React.useState(false)
      // `true` once the wait for the configuration scope has lasted long enough that
      // "still loading" is no longer the honest answer (see SCOPE_MISSING_NOTE).
      const [scopeWaitExpired, setScopeWaitExpired] = React.useState(false)

      React.useEffect(
        () =>
          model.subscribe(() => {
            setSnapshot(model.read())
          }),
        [model],
      )

      // Bound the wait for the namespace: while it is still loading, arm one timer; the
      // moment the scope arrives (or the panel unmounts) the timer is cleared.
      React.useEffect(() => {
        if (snapshot.status === 'ready' || typeof setTimeout !== 'function') return undefined
        const timer = setTimeout(() => setScopeWaitExpired(true), SCOPE_WAIT_MS)
        return () => {
          if (typeof clearTimeout === 'function') clearTimeout(timer)
        }
      }, [snapshot.status])

      // Read the current startup directory once, on mount. A route this DSH does not
      // serve (an older Host half) must degrade to an empty field plus a note, never to
      // an exception in the middle of a render.
      React.useEffect(() => {
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) {
          // BOTH fields, always: a field left in 'loading' has its save button disabled
          // forever, which looks like a broken panel rather than a failed read.
          setTerminal({
            status: 'unavailable',
            path: '',
            available: true,
            error: '这个环境没有 fetch，读不到当前值',
          })
          setScrollback({
            status: 'unavailable',
            value: null,
            available: true,
            error: '这个环境没有 fetch，读不到当前值',
          })
          return undefined
        }
        let live = true
        // Bounded like the feedback read below: a route that never answers must not leave
        // the field disabled forever — it degrades to a note and an editable field.
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = typeof setTimeout === 'function'
          ? setTimeout(() => {
            if (controller !== undefined) controller.abort()
          }, 12000)
          : undefined
        Promise.resolve(fetcher(TERMINAL_ROUTE, {
          headers: { accept: 'application/json' },
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        }))
          .then((response) => (response !== undefined && response !== null
            && typeof response.json === 'function'
            ? response.json()
            : undefined))
          .then((payload) => {
            if (timer !== undefined) clearTimeout(timer)
            if (!live) return
            if (payload === undefined || payload === null || typeof payload !== 'object') {
              setTerminal({
                status: 'unavailable',
                path: '',
                available: true,
                error: '插件路由没有返回可用的值',
              })
              setScrollback({
                status: 'unavailable',
                value: null,
                available: true,
                error: '插件路由没有返回可用的值',
              })
              return
            }
            setTerminal({
              status: 'ready',
              path: typeof payload.path === 'string' ? payload.path : '',
              // Absent means "assume the row is there": an older Host half that does
              // not send the field must not make the panel claim the opt-in is missing.
              available: payload.available !== false,
              error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
            })
            setScrollback({
              status: 'ready',
              value: typeof payload.scrollback === 'number' ? payload.scrollback : null,
              available: payload.available !== false,
              error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
            })
          })
          .catch(() => {
            if (timer !== undefined) clearTimeout(timer)
            if (live) {
              setTerminal({
                status: 'unavailable',
                path: '',
                available: true,
                error: '插件路由不可达',
              })
              setScrollback({
                status: 'unavailable',
                value: null,
                available: true,
                error: '插件路由不可达',
              })
            }
          })
        return () => {
          live = false
          if (timer !== undefined) clearTimeout(timer)
          if (controller !== undefined) controller.abort()
        }
      }, [])

      /**
       * Fold one `/dsh-wsl-tool/channel` payload into state. The mount read, 刷新, the
       * install action and 新建会话 all go through this, so the picker, the notes and the
       * button labels can never disagree about the same snapshot.
       */
      const applyChannelPayload = (payload) => {
        if (payload === undefined || payload === null) return
        setChannelInfo({
          status: 'ready',
          available: payload.available !== false,
          shim: payload.shim !== null && payload.shim !== undefined && payload.shim.installed === true,
          port: typeof payload.port === 'number' ? payload.port : null,
          host: typeof payload.host === 'string' ? payload.host : null,
          error: typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined,
          sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        })
      }

      /** Read the channel state (mount, 刷新, after installs and after creating a session). */
      const loadChannel = () => {
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) return Promise.resolve(undefined)
        return fetcher(CHANNEL_STATE_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response !== undefined && response !== null
            && typeof response.json === 'function' ? response.json() : undefined))
          .then((payload) => {
            applyChannelPayload(payload)
            return payload
          })
          .catch((error) => {
            setChannelInfo({
              status: 'unavailable',
              available: false,
              shim: false,
              port: null,
              host: null,
              error: String(error?.message ?? error),
              sessions: [],
            })
            return undefined
          })
      }

      // Read the WSL channel's facts once (port, host, shim, and the sessions the picker
      // offers). On a cold start the host may answer before its session query has
      // settled, which is what made the first dropdown look empty until 刷新 — one
      // silent retry covers that without asking the user to press anything.
      React.useEffect(() => {
        let live = true
        loadChannel().then((payload) => {
          if (!live) return
          const empty = payload === undefined || !Array.isArray(payload.sessions) || payload.sessions.length === 0
          if (!empty) return
          if (typeof setTimeout !== 'function') return
          const timer = setTimeout(() => { if (live) loadChannel() }, 900)
          if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
        })
        return () => { live = false }
      }, [])

      /**
       * Send one write and reflect its outcome. The promise is returned so a
       * caller (or a test) can await the settled state; React ignores the return
       * value of an event handler, and `model.write` never rejects.
       */
      const submit = (op, key) => {
        setBusy(key)
        setRefused(false)
        return model.write(op).then((landed) => {
          setBusy(undefined)
          setRefused(!landed)
          setSnapshot(model.read())
          return landed
        })
      }

      /** One switch row: copy on the left, an override badge and the switch on the
       *  right. Clearing overrides is NOT offered per row — the panel has one
       *  control for that, so eleven rows do not repeat the same button. */
      const rowElement = (row) => {
        const key = row.path.join('.')
        const overridden = hasPath(snapshot.user, row.path)
        const disabled = snapshot.writable !== true || busy !== undefined
        const effective = readPath(snapshot.value, row.path)
        const checked = effective === undefined ? row.when : effective === true
        return React.createElement(
          'div',
          { key, style: ROW_STYLE },
          React.createElement(
            'div',
            { style: ROW_COPY_STYLE },
            React.createElement(
              'div',
              { style: ROW_LABEL_STYLE },
              row.label,
              row.danger === true ? React.createElement('span', { style: DANGER_STYLE }, '有风险') : null,
              row.caution === true ? React.createElement('span', { style: DANGER_STYLE }, '打开需谨慎') : null,
            ),
            React.createElement('p', { style: HINT_STYLE }, row.hint),
          ),
          React.createElement(
            'div',
            { style: ROW_ACTIONS_STYLE },
            overridden ? React.createElement('span', { style: BADGE_STYLE }, '已覆盖') : null,
            React.createElement(primitives.Switch, {
              checked,
              label: row.label,
              disabled,
              ...(row.danger === true
                ? { title: '有风险：关掉后模型可以直接执行删除、分区、关机等命令' }
                : row.caution === true
                  ? { title: row.cautionTitle ?? '打开需谨慎：它授权插件以 root 在发行版内做固定的事（安装工具链，或按调用要求以 root 运行命令）' }
                  : {}),
              onChange: (next) => submit({ op: 'set', path: row.path, value: next === true }, key),
            }),
          ),
        )
      }

      /**
       * The sidebar terminal's startup directory.
       *
       * The 新建终端 shell belongs to another plugin, so this value cannot travel
       * through the settings scope the switches use: it lives in the profile's own
       * patch layer and is edited over the Host's route. One input and one 保存 — the
       * field is never repeated per row.
       */
      const terminalCwdSection = () => {
        const draft = terminalDraft === undefined
          ? (typeof terminal.path === 'string' ? terminal.path : '')
          : terminalDraft
        const busySave = terminalSave !== undefined && terminalSave.status === 'busy'
        // Saving is withheld while the current value is still being read (an empty field
        // there is "not loaded yet", not "the user cleared it") and when this profile has
        // no terminal row at all (the Host would only refuse it). The INPUT stays editable
        // in both cases: a field nobody can type into reads as a broken panel, and typing
        // is harmless while the write is withheld.
        const missingRow = terminal.status === 'ready' && terminal.available === false
        const cannotSave = busySave || terminal.status === 'loading' || missingRow
        const save = () => {
          const value = draft.trim()
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) {
            setTerminalSave({ status: 'failed', error: '这个环境不能访问插件路由' })
            return Promise.resolve(false)
          }
          setTerminalSave({ status: 'busy' })
          // Returned so a test can await the settled state; a click handler ignores it.
          return Promise.resolve(fetcher(TERMINAL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ path: value }),
          }))
            .then((response) => (response !== undefined && response !== null
              && typeof response.json === 'function'
              ? response.json()
              : undefined))
            .then((payload) => {
              const ok = payload !== undefined && payload !== null && payload.ok === true
              const settled = payload !== undefined && payload !== null && typeof payload.path === 'string'
                ? payload.path
                : value
              if (ok) {
                setTerminal({ status: 'ready', path: settled, available: true, error: undefined })
                setTerminalSave({ status: 'ok', path: settled })
                // Back to the authoritative value, like the workdir field does: what is saved is
                // the trimmed text, so leaving the raw draft on screen would show whitespace the
                // field no longer represents — or, cleared, an empty box for a path that is set.
                setTerminalDraft(undefined)
              } else {
                const reason = payload !== undefined && payload !== null
                  && typeof payload.error === 'string' && payload.error !== ''
                  ? payload.error
                  : 'Host 拒绝了这次写入'
                setTerminalSave({ status: 'failed', error: reason })
              }
              return ok
            })
            .catch(() => {
              setTerminalSave({ status: 'failed', error: '请求插件路由失败' })
              return false
            })
        }
        const notes = []
        if (terminal.status === 'loading') {
          notes.push(React.createElement('p', { key: 'loading', style: NOTE_STYLE }, '正在读取当前启动路径…'))
        }
        if (busySave) {
          notes.push(React.createElement('p', { key: 'saving', style: NOTE_STYLE }, '正在保存…'))
        } else if (terminalSave !== undefined && terminalSave.status === 'ok') {
          notes.push(React.createElement('p', { key: 'saved', style: NOTE_STYLE },
            terminalSave.path === ''
              ? '已保存：不设置 `--cd`（终端从会话工作区启动）。重启 DSH 后生效。'
              : '已保存：' + terminalSave.path + '。重启 DSH 后生效。'))
        } else if (terminalSave !== undefined && terminalSave.status === 'failed') {
          notes.push(React.createElement('p', { key: 'save-failed', style: NOTE_STYLE },
            '保存失败：' + (typeof terminalSave.error === 'string' ? terminalSave.error : '原因未知')))
        }
        const readError = typeof terminal.error === 'string' && terminal.error !== ''
        // "No terminal row" is only the diagnosis when the Host could actually READ the
        // file: a failure to find the patch layer at all reports `available: false` too,
        // and pointing at the opt-in recipe then sends the reader after the wrong thing
        // (measured: a host that could not name its patch file looked like a missing row).
        if (terminal.status === 'ready' && terminal.available === false && !readError) {
          notes.push(React.createElement('p', { key: 'no-row', style: NOTE_STYLE },
            '当前组合里还没有 WSL 终端这一项。先按 README 的「可选：在侧边栏开一个 WSL 终端」启用，再设置启动目录。'))
        }
        if (readError) {
          notes.push(React.createElement('p', { key: 'read-failed', style: NOTE_STYLE },
            '读取失败：' + terminal.error + '（保存仍会尝试写入）'))
        }
        return section(
          'terminal-cwd',
          'WSL 终端启动路径',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              placeholder: '/mnt/d/project、~（留空 = 跟随会话工作区）',
              disabled: busySave,
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setTerminalDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: cannotSave,
                onClick: save,
              },
              busySave ? '保存中…' : '保存',
            ),
          ),
          React.createElement('p', { style: HINT_STYLE },
            '侧边栏「新建终端」里 WSL 终端的启动目录。可填 `/mnt/...`、`~` 或绝对 Windows 路径；留空表示不指定。'
            + '修改后需要重启 DSH 生效。'),
          ...notes,
        )
      }

      /**
       * How much history the sidebar terminal keeps.
       *
       * The app's terminal component builds its emulator with the `scrollback` the Host
       * reports (`@deepseek-ai/dsh-client-ui-sidebar-terminal`: `scrollback:
       * …environment?.scrollback ?? 0`), and that number is this row's own setting — so
       * raising it here is what stops long output from scrolling out of reach. Empty
       * clears the key, which hands the choice back to the platform default.
       */
      const terminalScrollbackSection = () => {
        const shown = scrollback.value === null ? '' : String(scrollback.value)
        const draft = scrollbackDraft === undefined ? shown : scrollbackDraft
        const busySave = scrollbackSave !== undefined && scrollbackSave.status === 'busy'
        const missingRow = scrollback.status === 'ready' && scrollback.available === false
        const cannotSave = busySave || scrollback.status === 'loading' || missingRow
        const save = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) {
            setScrollbackSave({ status: 'failed', error: '这个环境不能访问插件路由' })
            return
          }
          setScrollbackSave({ status: 'busy' })
          return Promise.resolve(fetcher(TERMINAL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scrollback: draft.trim() }),
          }))
            .then((response) => (response !== undefined && response !== null
              && typeof response.json === 'function' ? response.json() : undefined))
            .then((payload) => {
              const settled = payload !== undefined && payload !== null && typeof payload === 'object' ? payload : {}
              if (settled.ok === true) {
                const landed = typeof settled.scrollback === 'number' ? settled.scrollback : null
                setScrollback({ status: 'ready', value: landed, available: true, error: undefined })
                setScrollbackDraft(undefined)
                setScrollbackSave({ status: 'ok', value: landed })
                return true
              }
              const reason = typeof settled.error === 'string' && settled.error !== '' ? settled.error : '保存失败'
              setScrollbackSave({ status: 'failed', error: reason })
              return false
            })
            .catch(() => {
              setScrollbackSave({ status: 'failed', error: '请求插件路由失败' })
              return false
            })
        }
        const notes = []
        if (scrollback.status === 'unavailable' || (scrollback.error !== undefined && scrollback.status === 'ready')) {
          notes.push(React.createElement('p', { key: 'read-note', style: NOTE_STYLE },
            '当前值读取失败：' + (scrollback.error ?? '不可用') + '（保存仍会尝试写入）'))
        }
        if (missingRow) {
          notes.push(React.createElement('p', { key: 'no-row', style: NOTE_STYLE },
            '当前组合里还没有 WSL 终端这一项。先按 README 的「可选：在侧边栏开一个 WSL 终端」启用，再设置历史行数。'))
        }
        if (busySave) {
          notes.push(React.createElement('p', { key: 'saving', style: NOTE_STYLE }, '正在保存…'))
        } else if (scrollbackSave !== undefined && scrollbackSave.status === 'ok') {
          notes.push(React.createElement('p', { key: 'saved', style: NOTE_STYLE },
            scrollbackSave.value === null
              ? '已保存：使用默认值。重启 DSH 后生效。'
              : `已保存：${scrollbackSave.value} 行。重启 DSH 后生效。`))
        } else if (scrollbackSave !== undefined && scrollbackSave.status === 'failed') {
          notes.push(React.createElement('p', { key: 'failed', style: NOTE_STYLE },
            '保存失败：' + (typeof scrollbackSave.error === 'string' ? scrollbackSave.error : '原因未知')))
        }
        return section(
          'terminal-scrollback',
          '终端历史行数',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              placeholder: `留空 = 用默认值（1000）`,
              disabled: busySave,
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setScrollbackDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: cannotSave,
                onClick: save,
              },
              busySave ? '保存中…' : '保存',
            ),
          ),
          React.createElement('p', { style: HINT_STYLE },
            '侧边栏终端保留多少行历史（数字，0 表示不留）。留空则使用平台默认值。修改后需要重启 DSH 生效。'),
          ...notes,
        )
      }

      /**
       * The model-facing default directory, written through the settings scope like a
       * switch. Empty means "no fixed directory", which hands the decision back to
       * 「默认跟随会话工作区」.
       *
       * The draft is STATE, not a closure variable: the scope snapshot can be replaced
       * between typing and clicking 保存 (any switch toggle, or a settling route read), and
       * a rebuilt closure would then save the snapshot's value instead of what is on screen
       * — a silent wrong write. `undefined` means "nothing typed yet", so the scope's value
       * fills the box.
       */
      const workdirSection = () => {
        const shown = readPath(snapshot.value, ['workdir'])
        const draft = workdirDraft === undefined
          ? (typeof shown === 'string' ? shown : '')
          : workdirDraft
        return section(
          'workdir',
          '默认 Linux 工作目录',
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: draft,
              placeholder: '/mnt/d/project（留空 = 跟随会话工作区）',
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setWorkdirDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: snapshot.writable !== true || busy !== undefined,
                onClick: () => submit([draft.trim() === ''
                  ? { op: 'unset', path: ['workdir'] }
                  : { op: 'set', path: ['workdir'], value: draft.trim() }], 'workdir')
                  .then((landed) => {
                    // Once it is written (or refused with a note), the box follows the scope
                    // again; keeping the draft forever would hide a change made elsewhere.
                    if (landed) setWorkdirDraft(undefined)
                    return landed
                  }),
              },
              '保存',
            ),
          ),
          React.createElement('p', { style: HINT_STYLE },
            '模型没有指定目录时使用的固定目录，优先于「默认跟随会话工作区」；`~` 表示 Linux 家目录。'),
        )
      }

      /**
       * The WSL terminal command: what the channel is, and which conversation it lands in.
       * The session is a settings field — a picker over the client's own sessions plus a
       * create button, so nobody has to know an id — while installing the shim is a route
       * because it writes a file in another operating system.
       */
      const channelSection = () => {
        const stored = readPath(snapshot.value, ['channelSession'])
        const picked = typeof stored === 'string' ? stored : ''
        const sessions = Array.isArray(channelInfo.sessions) ? channelInfo.sessions : []
        const known = picked === '' || sessions.some((row) => row.id === picked)
        const choose = (id) => submit([id === ''
          ? { op: 'unset', path: ['channelSession'] }
          : { op: 'set', path: ['channelSession'], value: id }], 'channelSession')
        const createAndChoose = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) return
          setChannelListBusy(true)
          setChannelInstall(undefined)
          fetcher(CHANNEL_NEW_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: channelNewDraft.trim() }),
          })
            .then((response) => (response !== undefined && response !== null
              && typeof response.json === 'function' ? response.json() : undefined))
            .then((payload) => {
              if (payload === undefined || payload === null) return undefined
              if (payload.ok !== true) {
                setChannelInstall({ ok: false, detail: payload.detail ?? '新建会话失败' })
                return undefined
              }
              setChannelNewDraft('')
              return choose(payload.sessionId ?? '')
            })
            .catch((error) => setChannelInstall({ ok: false, detail: String(error?.message ?? error) }))
            .finally(() => {
              setChannelListBusy(false)
              loadChannel()
            })
        }
        const install = () => {
          const fetcher = typeof fetch === 'function' ? fetch : undefined
          if (fetcher === undefined) return
          setChannelBusy(true)
          setChannelInstall(undefined)
          fetcher(CHANNEL_INSTALL_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
            .then((response) => (response !== undefined && response !== null
              && typeof response.json === 'function' ? response.json() : undefined))
            .then((payload) => {
              setChannelInstall(payload ?? { ok: false, detail: '插件路由没有返回可用的值' })
            })
            .catch((error) => setChannelInstall({ ok: false, detail: String(error?.message ?? error) }))
            .finally(() => {
              setChannelBusy(false)
              loadChannel()
            })
        }
        const rows = Array.isArray(channelInfo.sessions) ? channelInfo.sessions : []
        const rowElement = (row) => React.createElement(
          'button',
          {
            key: row.id,
            type: 'button',
            style: {
              display: 'flex',
              alignItems: 'baseline',
              gap: '10px',
              width: '100%',
              boxSizing: 'border-box',
              textAlign: 'left',
              padding: '7px 10px',
              borderRadius: RADIUS,
              border: '1px solid ' + (row.id === picked ? BORDER_BADGE : BORDER_SOFT),
              background: 'transparent',
              color: LABEL_PRIMARY,
              fontFamily: 'inherit',
              fontSize: '12.5px',
              lineHeight: '18px',
              cursor: 'pointer',
            },
            onClick: () => choose(row.id),
          },
          React.createElement('span',
            { style: { color: row.id === picked ? LABEL_PRIMARY : LABEL_TERTIARY } },
            row.id === picked ? '●' : '○'),
          React.createElement('span',
            { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            row.title || '(未命名)'),
          React.createElement('span',
            { style: { color: LABEL_TERTIARY, flexShrink: 0 } },
            [relativeTime(row.createdAt), row.workspace]
              .filter((part) => typeof part === 'string' && part !== '')
              .join(' · ')),
        )
        const note = channelInfo.status === 'ready'
          ? (channelInfo.available === false
            ? '这个宿主没有启动通道服务（WSL 没在运行，或 wsl.exe 不可用）。'
            : `通道监听 ${channelInfo.host ?? '?'}:${String(channelInfo.port ?? '?')}；shim ${channelInfo.shim ? '已安装' : '未安装'}。`)
          : channelInfo.status === 'loading'
            ? '正在读取通道状态…'
            : (channelInfo.error ?? '通道状态不可用')
        return section(
          'channel',
          'WSL 终端里的 DSH 命令',
          React.createElement('p', { style: HINT_STYLE },
            '这里的「通道」不是又一个会话：它是插件在本机开的一个小服务，只负责把 WSL 终端里的 dsh 命令转给 DSH。消息会出现在下面选中的会话里，回复流式回到终端。'),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
            React.createElement('span', { style: HINT_STYLE }, '对话落在（最近 12 个有标题的会话）'),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelListBusy,
              onClick: () => {
                setChannelListBusy(true)
                loadChannel().finally(() => setChannelListBusy(false))
              },
            }, channelListBusy ? '刷新中…' : '刷新'),
          ),
          rows.length === 0
            ? React.createElement('p', { style: NOTE_STYLE }, '暂时没有可选的会话；下面可以直接新建一个。')
            : React.createElement('div', { style: STACK_STYLE }, rows.map(rowElement)),
          picked !== '' && known === false
            ? React.createElement('p', { style: NOTE_STYLE },
              `当前落点 ${picked} 不在列表里（可能已删除，或还没建）；请重新选一个，或新建。`)
            : null,
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('input', {
              type: 'text',
              value: channelNewDraft,
              placeholder: '新会话名，例如 wsl',
              style: INPUT_STYLE,
              onChange: (event) => {
                const next = event !== null && event !== undefined && event.target !== undefined
                  ? event.target.value
                  : ''
                setChannelNewDraft(typeof next === 'string' ? next : '')
              },
            }),
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelListBusy,
              onClick: createAndChoose,
            }, '新建并选用'),
          ),
          React.createElement(
            'div',
            { style: FIELD_ROW_STYLE },
            React.createElement('button', {
              type: 'button',
              style: RESET_STYLE,
              disabled: channelBusy,
              onClick: install,
            }, channelBusy ? '安装中…' : (channelInfo.shim ? '重新安装 dsh 命令' : '安装 dsh 命令')),
          ),
          React.createElement('p', { style: HINT_STYLE },
            '装好后，WSL 终端输入 `dsh help` 查看全部命令；直接用 `dsh "问题"` 就对上面选中的会话说话。'),
          React.createElement('p', { style: NOTE_STYLE }, note),
          channelInstall === undefined
            ? null
            : React.createElement('p', { style: NOTE_STYLE },
              channelInstall.ok === true
                ? `已安装到 ${channelInstall.target ?? '~/.local/bin/dsh'}`
                : `失败：${channelInstall.detail ?? '未知原因'}`),
        )
      }

      const children = []

      children.push(
        React.createElement(
          'header',
          { key: 'header', style: HEADER_STYLE },
          React.createElement('h2', { style: TITLE_STYLE }, 'WSL'),
          React.createElement('p', { style: DESCRIPTION_STYLE }, '让模型在 WSL 里执行 Linux 命令、转换路径、检查环境，并可在你打开的终端里工作'),
          React.createElement('p', { style: NOTE_STYLE }, '开关改动即时生效；两个终端设置项（启动路径、历史行数）需要重启 DSH。'),
          // The terminal tool has no switch — opening a terminal here IS the consent — so the
          // handover has to be explained where a terminal is opened, not on a switch row.
          React.createElement('p', { style: NOTE_STYLE }, '你打开的终端，模型也可以在里面工作：界面会让你先看到它跑的命令。模型工作期间该终端只读，点终端里的「接管输入」即可拿回键盘。'),
        ),
      )

      // The two directories this panel owns, one control each, at the top: the model's
      // working directory (this plugin's own setting, written through the settings
      // scope) and the sidebar terminal's startup directory (a profile-patch row owned
      // by another plugin, written over the Host's route). One stack because they are
      // the same question — "where does this start?" — asked of two different things.
      // The terminal field is rendered in every branch: it does not travel through the
      // settings service, so it must not disappear together with it.
      const directories = [terminalCwdSection(), terminalScrollbackSection()]
      if (snapshot.status === 'ready') directories.push(workdirSection(), channelSection())
      children.push(React.createElement('div', { key: 'directories', style: STACK_STYLE }, directories))

      // The switches — or the one reason they cannot be shown right now.
      if (model.hasService() !== true) {
        children.push(
          React.createElement(
            'p',
            { key: 'note-service', style: NOTE_STYLE },
            '当前 DSH 未提供配置表单服务（configForms），无法在此调整设置。',
          ),
        )
      } else if (snapshot.status === 'loading') {
        // A namespace that never arrives looks exactly like a slow one, so the wait is
        // bounded: past it, say what is actually missing instead of waiting forever. The
        // usual cause is a Host without the plugin's schema peer (no form is projected at
        // all) — and the tools plus the terminal field work regardless.
        children.push(React.createElement('p', { key: 'note-loading', style: NOTE_STYLE },
          scopeWaitExpired
            ? SCOPE_MISSING_NOTE
            : '正在等待 Host 提供该插件的配置作用域（' + CONFIG_ROW_ID + '）…'))
      } else if (snapshot.status !== 'ready') {
        children.push(
          React.createElement('p', { key: 'note-unavailable', style: NOTE_STYLE }, SCOPE_MISSING_NOTE),
        )
      } else {
        const overriddenPaths = SECTIONS
          .flatMap((group) => group.rows)
          .filter((row) => hasPath(snapshot.user, row.path))
          .map((row) => row.path)
        const blocks = SECTIONS.map((group) =>
          section(group.id, group.title, React.createElement('div', { style: ROWS_STYLE }, group.rows.map(rowElement))),
        )
        // ONE place to clear every override, instead of the same button repeated on
        // every row. "Put this panel back the way the composition had it" is one
        // intention, and the settings service takes it as one revision-fenced write.
        if (overriddenPaths.length > 0) {
          blocks.unshift(
            React.createElement(
              'div',
              { key: 'overrides', style: OVERRIDE_BAR_STYLE },
              React.createElement('span', { style: BADGE_STYLE }, '已覆盖 ' + overriddenPaths.length + ' 项'),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: RESET_STYLE,
                  disabled: snapshot.writable !== true || busy !== undefined,
                  // Returned as well as performed: React ignores a handler's return
                  // value, but awaiting it is how a test sees the write settle.
                  onClick: () => submit(overriddenPaths.map((path) => ({ op: 'unset', path })), 'all-overrides'),
                },
                '全部恢复默认',
              ),
            ),
          )
        }
        if (refused) {
          blocks.unshift(
            React.createElement('p', { key: 'note-refused', style: NOTE_STYLE }, '保存失败：配置未写入，请重试'),
          )
        }
        children.push(React.createElement('div', { key: 'switches', style: STACK_STYLE }, blocks))
      }

      // The effective values of the two knobs that have no switch, because they
      // are a distro name and a duration rather than a boolean.
      if (snapshot.status === 'ready') {
        const distro = readPath(snapshot.value, ['distro'])
        const timeoutMs = readPath(snapshot.value, ['timeoutMs'])
        children.push(
          section(
            'defaults',
            '当前默认值',
            React.createElement(
              'div',
              null,
              definitionRow(
                '发行版 distro',
                typeof distro === 'string' && distro.trim() !== '' ? distro : '系统默认发行版',
              ),
              definitionRow(
                '命令超时 timeoutMs',
                typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs + ' 毫秒' : '—',
              ),
            ),
            React.createElement(
              'p',
              { style: HINT_STYLE },
              '这两项来自插件配置：可在 profile 的 `cordis.patch.yml` 中设置，或用环境变量 `DSH_WSL_DISTRO` / `DSH_WSL_TIMEOUT_MS` 覆盖。',
            ),
          ),
        )
      }

      // ------------------------------------------------------- feedback (one entry)
      //
      // One place, two ways out: the issue chooser for anyone who can reach GitHub,
      // and this plugin's own facts as text for anyone who cannot (measured on this
      // machine: github.com is not always reachable). The guide sits beside the
      // button, because "where does this go" is the question the copied block raises.
      // Nothing is sent by this plugin: the bytes leave only when the user pastes them.
      const FEEDBACK_URL = 'https://github.com/XINY11451/dsh-wsl/issues/new/choose'

      const switchLines = () => SECTIONS.flatMap((group) =>
        group.rows.map((row) => {
          const effective = readPath(snapshot.value, row.path)
          const checked = effective === undefined ? row.when : effective === true
          return `- ${row.label}：${checked ? '开' : '关'}`
        }),
      )

      /**
       * The block the button copies: the plugin's own facts.
       *
       * `info` is what the Host half answered on `/dsh-wsl-tool/info`, read from this
       * package's manifest, so no version is ever copied by hand. When it is missing
       * — an older host, a route that never mounted, a blocked request — the block
       * says so instead of inventing a number, and still carries what this panel knows.
       */
      const infoText = (info) => {
        const hostConfig = info !== null && typeof info === 'object' ? info.config : undefined
        const lines = ['### 插件信息（插件自动读取，可直接粘贴）']
        if (info === undefined || info === null) {
          lines.push('- 版本：未能读取（见市场条目，或 `npm ls dsh-wsl-tool`）')
          lines.push('- DSH：未能读取（可在设置中查看）')
          lines.push('- WSL 发行版与内核：未能读取（可运行一次 `wsl-env` 工具）')
        } else {
          lines.push(`- 插件：${info.name} ${info.version ?? '（版本未知）'}`)
          if (typeof info.repository === 'string' && info.repository !== '') lines.push(`- 仓库：${info.repository}`)
          if (typeof info.node === 'string') lines.push(`- Node ${info.node}　平台 ${info.platform} ${info.arch}`)
          // Both of these are read by the host half; a value that could not be read
          // says so rather than being invented.
          const dsh = info.dsh
          lines.push(dsh !== null && dsh !== undefined && typeof dsh.version === 'string'
            ? `- DSH：${dsh.version}（${dsh.name}）`
            : '- DSH：未能读取（可在设置中查看）')
          const wsl = info.wsl
          if (wsl !== null && wsl !== undefined && typeof wsl === 'object') {
            const parts = []
            if (typeof wsl.defaultDistro === 'string' && wsl.defaultDistro !== '') {
              parts.push(`${wsl.defaultDistro}（默认发行版）`)
            }
            if (typeof wsl.kernel === 'string' && wsl.kernel !== '') parts.push(`内核 ${wsl.kernel}`)
            lines.push(`- WSL：${parts.length > 0 ? parts.join('；') : '未探测到发行版或内核'}`)
            if (Array.isArray(wsl.capabilities) && wsl.capabilities.length > 0) {
              lines.push(`- WSL 能力：${wsl.capabilities.join('　')}`)
            }
          } else {
            lines.push('- WSL：未能读取（可运行一次 `wsl-env` 工具）')
          }
        }
        lines.push('')
        lines.push('### 面板开关状态')
        lines.push(...switchLines())
        const distro = hostConfig?.distro ?? readPath(snapshot.value, ['distro'])
        const timeoutMs = hostConfig?.commandTimeoutMs ?? readPath(snapshot.value, ['timeoutMs'])
        lines.push(`- 发行版 distro：${typeof distro === 'string' && distro.trim() !== '' ? distro : '系统默认'}`)
        lines.push(`- 命令超时 timeoutMs：${typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? `${timeoutMs} 毫秒` : '—'}`)
        return lines.join('\n')
      }

      const writeFeedback = (text) => {
        const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          // No clipboard API (or no permission): show the text so it can be selected.
          setFeedbackText(text)
          setFeedbackCopy('manual')
          return
        }
        try {
          Promise.resolve(clipboard.writeText(text)).then(
            () => setFeedbackCopy('ok'),
            () => {
              setFeedbackText(text)
              setFeedbackCopy('manual')
            },
          )
        } catch {
          setFeedbackText(text)
          setFeedbackCopy('manual')
        }
      }

      const copyInfo = () => {
        // The Host half's answer is cached after the first success: the second click
        // copies without a round trip.
        if (selfInfo !== undefined) {
          writeFeedback(infoText(selfInfo))
          return undefined
        }
        const fetcher = typeof fetch === 'function' ? fetch : undefined
        if (fetcher === undefined) {
          writeFeedback(infoText(undefined))
          return undefined
        }
        // Bounded, but generously: the host half probes WSL (a few round trips) before
        // it answers, and aborting early would paste a block full of "unreadable".
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined
        const timer = typeof setTimeout === 'function'
          ? setTimeout(() => {
            if (controller !== undefined) controller.abort()
          }, 12000)
          : undefined
        setFeedbackCopy('busy')
        // Returned so a test can await the round trip; a click handler may ignore it.
        return Promise.resolve(fetcher(INFO_ROUTE, {
          headers: { accept: 'application/json' },
          ...(controller !== undefined ? { signal: controller.signal } : {}),
        }))
          .then((response) => (response !== undefined && response !== null && response.ok === true
            ? response.json()
            : undefined))
          .then((info) => {
            if (timer !== undefined) clearTimeout(timer)
            if (info !== undefined && info !== null && typeof info === 'object') setSelfInfo(info)
            writeFeedback(infoText(info ?? undefined))
          })
          .catch(() => {
            if (timer !== undefined) clearTimeout(timer)
            writeFeedback(infoText(undefined))
          })
      }

      children.push(
        section(
          'feedback',
          '反馈与支持',
          React.createElement(
            'div',
            { style: OVERRIDE_BAR_STYLE },
            React.createElement(
              'a',
              {
                href: FEEDBACK_URL,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: { color: LINK_LABEL, fontSize: '12px' },
              },
              '在 GitHub 打开反馈页',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: RESET_STYLE,
                disabled: feedbackCopy === 'busy',
                onClick: copyInfo,
              },
              feedbackCopy === 'busy'
                ? '正在读取…'
                : feedbackCopy === 'ok' ? '已复制 ✓' : '复制插件信息',
            ),
          ),
          React.createElement('p', { style: HINT_STYLE }, FEEDBACK_URL),
          React.createElement(
            'ol',
            { style: GUIDE_STYLE },
            ...GUIDE.map((line, index) =>
              React.createElement('li', { key: `guide-${index}`, style: GUIDE_ITEM_STYLE }, line)),
          ),
          feedbackCopy === 'manual' ? React.createElement('pre', { style: PRE_STYLE }, feedbackText) : null,
          feedbackCopy === 'manual'
            ? React.createElement('p', { style: HINT_STYLE },
              '（浏览器未允许自动复制：请全选上方内容后粘贴）')
            : null,
        ),
      )

      return React.createElement('div', { style: PANEL_STYLE }, children)
    }

    // ------------------------------------------------------------------ apply

    /**
     * Mount the rail entry and the panel.
     *
     * This function must never throw: a client half that fails to apply takes its
     * whole bundle's surface down with it, and the WSL tools work fine without any
     * of this. So a missing `slots` service, a missing `configForms`, an unserved
     * configuration row and a scope that refuses to be read all degrade into a note
     * in the panel instead of an exception.
     */
    function apply(ctx) {
      const model = createConfigModel()

      // `configForms` is reached through `ctx.inject`, never through this module's
      // own `inject` array: the panel is a convenience, not a reason to refuse to
      // mount on a composition that does not ship the settings service.
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], (inner) => {
            const configForms = inner.configForms
            if (configForms === undefined || configForms === null) return
            // The service is here; whether it lists our namespace is a separate
            // question that `whileServed` answers below.
            model.noteService()
            /**
             * Take the form once the Host actually lists the namespace.
             *
             * A form fetched before the `describe()` round trip settles is born
             * with its persistence already fixed to "not host" and never upgrades
             * — it stays `unavailable` forever. That is exactly how this panel
             * lost every switch while the tools kept working, so the namespace is
             * awaited through the platform's own gate instead of being requested
             * eagerly. The shipped settings pages use this same call.
             */
            const attachWhenServed = () => {
              if (typeof configForms.whileServed !== 'function') {
                // Older host face: no gate to wait on, so take whatever it gives
                // and let the model report `unavailable` honestly.
                attach(configForms.get(CONFIG_ROW_ID))
                return () => model.detach()
              }
              return configForms.whileServed([CONFIG_ROW_ID], () => {
                attach(configForms.get(CONFIG_ROW_ID))
                return () => model.detach()
              })
            }
            const attach = (scope) => {
              try {
                model.attach(scope)
              } catch (error) {
                console.error('dsh-wsl-tool: reading the "' + CONFIG_ROW_ID + '" configuration scope failed', error)
              }
            }
            let stop
            try {
              stop = attachWhenServed()
            } catch (error) {
              console.error('dsh-wsl-tool: this DSH serves no "' + CONFIG_ROW_ID + '" configuration row', error)
              return
            }
            // The subscription lives exactly as long as this fiber: `effect` runs
            // the returned disposer on unload or recomposition.
            if (typeof inner.effect === 'function') {
              inner.effect(() => stop, 'dsh-wsl-tool: configuration scope')
            }
          })
        }
      } catch (error) {
        console.error('dsh-wsl-tool: asking for the configuration service failed', error)
      }

      try {
        if (ctx.slots === undefined || ctx.slots === null) {
          console.error('dsh-wsl-tool: this DSH has no slots service; the WSL panel stays unmounted')
          return
        }
        // Both seats are registered from the innermost callback, exactly as the
        // shipped panels do: the rail entry and the panel it opens appear together
        // or not at all. The callback's return value is the disposer chain.
        ctx.slots.inject('main', () =>
          ctx.slots.inject('sidebar.panellist', () => {
            const stopMain = ctx.slots.register(
              { name: 'main', key: PANEL_ID, inject: () => ({ model }) },
              WslPanel,
            )
            const stopIcon = ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: () => 'WSL' },
              WslIcon,
            )
            return () => {
              if (typeof stopIcon === 'function') stopIcon()
              if (typeof stopMain === 'function') stopMain()
            }
          }),
        )
      } catch (error) {
        console.error('dsh-wsl-tool: registering the WSL panel failed', error)
      }

      try {
        // The terminal-subtask row above the composer: the same seats mechanism as the panel,
        // in the dock the shipped Todo/Goal/Queue rows already occupy, ordered after them (30).
        // A Host without this slot simply shows nothing — this is a leaf of its own.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'wsl-subtasks', order: 30 },
          WslSubtaskDock,
        ))
      } catch (error) {
        console.error('dsh-wsl-tool: registering the terminal-subtask dock failed', error)
      }
    }

    // `slots` is the one service this module needs before it can do anything.
    // `configForms` is optional and is asked for above, at runtime.
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
