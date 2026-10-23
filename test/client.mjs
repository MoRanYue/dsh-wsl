// Client-half checks: load `lib/client.js` the way DSH does — through the module
// loader, with a mocked `require` — and drive the panel it registers.
//
// The client half is hand-written (no build step), so nothing else proves it
// still parses, still asks for the services it needs, or still writes the
// configuration paths the Host half reads. `test/smoke.mjs` covers the Host;
// this file covers the surface a user actually clicks.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = resolve(root, 'lib/client.js')

let passed = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// --- load it the way the loader does ---------------------------------------

const source = readFileSync(clientPath, 'utf8')
const silent = { error() {}, warn() {}, log() {} }

console.log('\nclient bundle shape')
check('it is a plain loader script, not an ES module', !/^\s*(?:import|export)\s/m.test(source))
check('it never asks for a service by bare global', !/\bself\./.test(source))
// The package id it hands the loader is asserted at runtime below ("the module id is the
// package name"), which is the value that matters — not this source-text appearance.

const loaded = []
// What the feedback entry copies, recorded from the clipboard stub the panel uses.
const copiedTexts = []
const context = createContext({
  window: { __ModuleLoader__: { load: (mod) => loaded.push(mod) } },
  console: silent,
  navigator: {
    clipboard: {
      writeText: (text) => {
        copiedTexts.push(text)
        return Promise.resolve()
      },
    },
  },
})
// Timers: the panel arms two (a bounded wait for the settings scope, and an abort for the
// feedback read). Recording them lets a check fire one on demand instead of sleeping.
let timerSeq = 0
const timers = new Map()
context.setTimeout = (fn, ms) => {
  timerSeq += 1
  timers.set(timerSeq, { fn, ms })
  return timerSeq
}
context.clearTimeout = (id) => {
  timers.delete(id)
}
const fireTimers = (predicate) => {
  for (const [id, timer] of Array.from(timers)) {
    if (predicate !== undefined && !predicate(timer)) continue
    timers.delete(id)
    timer.fn()
  }
}
runInContext(source, context, { filename: clientPath })
eq('the loader received exactly one module', loaded.length, 1)
eq('the module id is the package name', loaded[0]?.id, 'dsh-wsl-tool')

// --- the module factory, with stubs for react and the primitives ------------

const elements = []
function element(type, props, ...children) {
  const node = { type, props: { ...(props ?? {}) } }
  if (children.length > 0) node.props.children = children.length === 1 ? children[0] : children
  elements.push(node)
  return node
}
const react = {
  createElement: element,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}
// One stable component per primitive name, tagged so the walk below can find a
// switch by the component it renders: the client passes the component itself as an
// element's `type`, and a Proxy that minted a fresh function per access would make
// every element a different type.
const primitiveCache = new Map()
const primitives = new Proxy({}, {
  get: (_target, key) => {
    if (!primitiveCache.has(key)) {
      const component = (props) => element(String(key), props)
      component.primitiveName = String(key)
      primitiveCache.set(key, component)
    }
    return primitiveCache.get(key)
  },
})
const mod = loaded[0].factory((name) => {
  if (name === 'react') return react
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${name}`)
})

console.log('\nclient module contract')
eq('it exports apply', typeof mod.apply, 'function')
eq('it injects only slots', JSON.stringify(mod.inject), '["slots"]')

// --- mount against a recording context --------------------------------------

const registered = []
const ops = []
/** Set to false to make the next write fail, so a refused save can be exercised. */
let scopeAccepts = true
const snapshot = {
  status: 'ready',
  value: { tools: { wsl: true, path: true, env: true }, backgroundJobs: true, translatePaths: true },
  base: {},
  user: { tools: { wsl: false }, dangerGuard: false }, // two overrides, so the single reset writes a real batch
  writable: true,
  revision: 7,
}
const scope = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: (batch, revision) => {
    ops.push({ batch, revision })
    return Promise.resolve(scopeAccepts)
  },
}
// The ORDER of these two calls is the point: a form fetched before the Host lists
// its namespace is born `unavailable` and never upgrades, which is how this panel
// lost every switch in the field. So the fake records the order.
const configFormsCalls = []
const configForms = {
  get: (namespace) => {
    configFormsCalls.push(`get:${namespace}`)
    return scope
  },
  whileServed: (namespaces, register) => {
    configFormsCalls.push(`whileServed:${namespaces.join(',')}`)
    const off = register(new Set(namespaces))
    return () => {
      if (typeof off === 'function') off()
    }
  },
}
const ctx = {
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      registered.push({ seat, component })
      return () => {}
    },
  },
  inject: (deps, callback) => {
    callback({ configForms, effect: () => () => {} })
  },
}
let threw = null
try {
  mod.apply(ctx)
} catch (error) {
  threw = error
}
check('apply mounts without throwing', threw === null, String(threw))
eq('it waits for the Host to serve the namespace', configFormsCalls[0], 'whileServed:tool-wsl')
eq('the form is taken only once the namespace is served', configFormsCalls[1], 'get:tool-wsl')

console.log('\nslot registration')
const main = registered.find((r) => r.seat.name === 'main')
const rail = registered.find((r) => r.seat.name === 'sidebar.panellist')
check('it registers a main panel', main !== undefined)
check('it registers a sidebar entry', rail !== undefined)
eq('both seats share one key', main?.seat.key, rail?.seat.id)
eq('the rail entry is labelled', rail?.seat.label?.(), 'WSL')
check('the rail entry has a paint order', Number.isFinite(rail?.seat.order), String(rail?.seat.order))

// --- render the panel and drive its controls --------------------------------

console.log('\npanel rendering')
elements.length = 0
const injected = typeof main?.seat.inject === 'function' ? main.seat.inject() : {}
check('the seat injects the configuration model', typeof injected.model === 'object')
let tree = null
try {
  tree = main.component({ ...injected })
} catch (error) {
  check('the panel renders', false, String(error))
}
const walk = (node, visit) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.type !== undefined) visit(node)
  walk(node.props?.children, visit)
}
const found = []
if (tree !== null) walk(tree, (node) => found.push(node))

/** Every node in a subtree, the root included. */
const collect = (node) => {
  const nodes = []
  walk(node, (child) => nodes.push(child))
  return nodes
}
/** A titled section, addressed by its heading rather than by document order: two
 *  sections now carry an input and a 保存, so order is no longer a safe selector. */
const sectionIn = (nodes, title) => nodes.find((node) => node.type === 'section'
  && Array.isArray(node.props?.children)
  && node.props.children[0] !== undefined
  && node.props.children[0].type === 'h3'
  && (node.props.children[0].props?.children === title
      || (Array.isArray(node.props.children[0].props?.children)
        && node.props.children[0].props.children.includes(title))))
const switches = found.filter((node) => node.type?.primitiveName === 'Switch')
check('it renders one switch per switchable feature', switches.length === 11,
  `found ${switches.length}; rendered: ${found.map((node) => String(node.type?.primitiveName ?? node.type)).join(',')}`)
const labels = switches.map((node) => node.props?.label).filter((v) => typeof v === 'string')
for (const expected of [
  'wsl 命令执行', 'wsl-path 路径转换', 'wsl-env 能力体检',
  'wsl-doctor 项目体检', 'wsl-bootstrap 安装工具链',
  '后台任务', '自动转换路径', '默认跟随会话工作区', '危险命令守卫', '管理员模式（root）',
  '启用 dsh 命令',
]) {
  check(`it labels the ${expected} row`, labels.includes(expected), labels.join(' | '))
}
// The terminal tool has no switch: a terminal the user opens is the consent it needs, so a
// switch row here would be a second, redundant permission — and the face of the panel would
// keep asking for something opening a terminal already decided.
check('there is no switch row for the terminal tool',
  !labels.includes('wsl-term 终端接入'), labels.join(' | '))
// The explanation and the risky marker are siblings inside a row, not props of the
// switch itself, so look for the text the panel actually renders.
const texts = []
const collectText = (node) => {
  if (typeof node === 'string') {
    texts.push(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectText(child)
    return
  }
  if (typeof node.props?.text === 'string') texts.push(node.props.text)
  collectText(node.props?.children)
}
collectText(tree)
const rendered = texts.join('\n')
// The panel is user-facing copy: it explains what each switch does in plain
// sentences, without parameter names or implementation terms.
for (const mention of ['全新的 shell', 'systemd', '后台执行', 'Windows 路径', '默认工作目录', '危险命令']) {
  check(`it renders the explanation mentioning "${mention}"`, rendered.includes(mention))
}
for (const jargon of ['`runInBackground`', '`translatePaths`', '`workdir`', '`asRoot`', '`dryRun`']) {
  check(`the panel does not name the ${jargon} parameter`, !rendered.includes(jargon), rendered.slice(0, 200))
}
check('the destructive-guard switch warns in its own tooltip',
  switches.some((node) => node.props?.label === '危险命令守卫' && /有风险/.test(String(node.props?.title))),
  JSON.stringify(switches.map((node) => node.props?.title)))
// Two rows authorise something on their ON position rather than removing it: the
// installer adds software and root runs a call privileged. Both have to say so, with
// wording that is not the guard's own (whose OFF position is the risk).
const cautionRows = ['wsl-bootstrap 安装工具链', '管理员模式（root）']
for (const label of cautionRows) {
  const row = switches.find((node) => node.props?.label === label)
  check(`the ${label} switch is marked 打开需谨慎`, row?.props?.title?.includes('打开需谨慎') === true, String(row?.props?.title))
}
check('the guard keeps its own wording rather than the new one',
  switches.some((node) => node.props?.label === '危险命令守卫' && String(node.props?.title).includes('有风险')),
  JSON.stringify(switches.map((node) => node.props?.title)))
check('the panel says the installer is off unless the user turns it on',
  rendered.includes('wsl-bootstrap 安装工具链') && rendered.includes('模型再次确认后才执行'),
  rendered.slice(0, 200))
check('and it explains that root is the authorisation itself',
  rendered.includes('管理员模式（root）') && rendered.includes('这项开关就是授权本身'), rendered.slice(0, 200))
// With no switch row, the terminal note is the only place the panel can say what joining
// the user's terminal means, so it has to name all three consequences: the model works in
// the terminal the user opened, that terminal is read-only while it does, and MEASURED, the
// keyboard does not come back by itself — the user clicks 接管输入.
// (Flattened inline: `textOf` is defined further down, after this point in the file.)
const terminalNote = collect(found).flatMap((node) => {
  const kids = node.props?.children
  const help = typeof node.props?.text === 'string' ? [node.props.text] : []
  if (typeof kids === 'string') return [kids, ...help]
  return Array.isArray(kids) ? [...kids.filter((kid) => typeof kid === 'string'), ...help] : help
}).join('\n')
check('the panel says the terminal tool works in the user\'s terminal, that it goes read-only, and how to take input back',
  terminalNote.includes('模型也可以在里面工作')
  && terminalNote.includes('只读')
  && terminalNote.includes('接管输入'),
  terminalNote.slice(0, 400))
// The panel now OFFERS the sidebar terminal's startup directory (one field, one 保存),
// but it still must not print the patch RECIPE: pointing a terminal at WSL is the
// user's own opt-in to make in their patch layer, and this panel prints no YAML. The
// recipe lives in extras/terminal-wsl.patch.yml and the README.
check('the sidebar-terminal patch snippet is not rendered',
  !rendered.includes('- id: terminal-controller') && !rendered.includes('args:') && !rendered.includes('wsl.exe'))
check('the panel never names the other plugin\'s row id',
  !rendered.includes('terminal-controller'), rendered.slice(0, 200))

console.log('\nconfiguration writes')
const wslSwitch = switches.find((node) => node.props?.label === 'wsl 命令执行')
let writeThrew = null
try {
  await wslSwitch.props.onChange(false)
} catch (error) {
  writeThrew = error
}
check('toggling a switch does not throw', writeThrew === null, String(writeThrew))
const setOp = ops.find((entry) => entry.batch?.[0]?.op === 'set')
eq('a toggle writes the row path', JSON.stringify(setOp?.batch?.[0]?.path), '["tools","wsl"]')
eq('a toggle writes the requested value', setOp?.batch?.[0]?.value, false)
eq('the write is fenced by the snapshot revision', setOp?.revision, 7)
// Clearing overrides lives in ONE place, not on every row: the panel renders a
// single control that unsets every overridden path in one revision-fenced write.
const resetControls = found.filter((node) => node.props?.children === '全部恢复默认')
eq('the panel offers exactly one reset control', resetControls.length, 1)
eq('the reset wording is not repeated on the rows', (rendered.match(/恢复默认/g) ?? []).length, 1)
let resetSettled = null
try {
  resetSettled = await resetControls[0].props.onClick({ preventDefault() {}, stopPropagation() {} })
} catch (error) {
  check('the reset control settles', false, String(error))
}
const unsetBatches = ops.filter((entry) => entry.batch?.some((op) => op.op === 'unset'))
eq('the reset sends one batch, not one write per row', unsetBatches.length, 1)
const unsetPaths = (unsetBatches[0]?.batch ?? [])
  .filter((op) => op.op === 'unset')
  .map((op) => op.path.join('.'))
  .sort()
eq('the batch covers every overridden path', unsetPaths.join(','), 'dangerGuard,tools.wsl')
eq('the reset is fenced by the snapshot revision', unsetBatches[0]?.revision, 7)
check('the reset reports success', resetSettled === true, String(resetSettled))

// The feedback entry: one place, a link to GitHub's issue chooser, and a locally
// assembled block for everyone who cannot reach GitHub — the plugin itself sends
// nothing, so the copied text is the whole contract.
// The workdir input: one place to set the fixed Linux directory, written through the
// same scope as the switches. Empty must clear the path rather than writing an empty
// string, which is what hands the decision back to the follow-session switch.
//
// Driven through a STATEFUL mount with a flush in between: the draft lives in state, and
// this field's whole failure mode is what happens when a re-render lands between typing and
// clicking 保存 (a switch toggle, or a settling route read). On the recording harness —
// where useState is a no-op — the typed value would never reach the save, which is exactly
// the silent wrong write this test exists to catch.
console.log('\nworkdir input')
const workdirSection = sectionIn(found, '默认 Linux 工作目录')
check('the panel offers a workdir section', workdirSection !== undefined)
const workdirInput = collect(workdirSection).find((node) => node.type === 'input')
check('the panel offers a workdir input', workdirInput !== undefined)
check('the workdir field can be typed into directly', String(workdirInput?.props?.placeholder).includes('可直接输入'), String(workdirInput?.props?.placeholder))
const saveWorkdir = collect(workdirSection).find((node) => node.props?.children === '保存')
check('it offers a save control', saveWorkdir !== undefined)

const workdirMount = mountStateful(main.component,
  typeof main?.seat.inject === 'function' ? main.seat.inject() : {})
await workdirMount.flush()
const liveWorkdir = () => {
  const area = sectionIn(collect(workdirMount.tree()), '默认 Linux 工作目录')
  const inner = area === undefined ? [] : collect(area)
  return {
    input: inner.find((node) => node.type === 'input'),
    save: inner.find((node) => typeof node.props?.children === 'string' && node.props.children.startsWith('保存')),
  }
}
liveWorkdir().input.props.onChange({ target: { value: '/mnt/d/proj' } })
await workdirMount.flush()
// A re-render between typing and saving must not lose the typed value.
const workdirOpsBefore = ops.length
await liveWorkdir().save.props.onClick()
check('saving writes the configured directory even after a re-render',
  ops.slice(workdirOpsBefore).some((entry) => entry.batch?.some((op) => op.op === 'set'
    && op.path.join('.') === 'workdir' && op.value === '/mnt/d/proj')),
  JSON.stringify(ops.slice(-2)))
liveWorkdir().input.props.onChange({ target: { value: '   ' } })
await workdirMount.flush()
const workdirOpsBeforeClear = ops.length
await liveWorkdir().save.props.onClick()
check('clearing it unsets the path instead of writing blanks',
  ops.slice(workdirOpsBeforeClear).some((entry) => entry.batch?.some((op) => op.op === 'unset'
    && op.path.join('.') === 'workdir')),
  JSON.stringify(ops.slice(-2)))
workdirMount.unmount()

// The sidebar terminal's startup directory: the same shape as the workdir field —
// one input, one 保存 — but it is NOT written through the settings scope, because the
// terminal row belongs to another plugin and only the profile patch can override it.
// The static checks here cover what is rendered; the async flow (reading the current
// value, saving, failing) is driven through a stateful mount further down.
console.log('\nterminal startup path field')
const terminalSection = sectionIn(found, 'WSL 终端启动路径')
check('the panel offers a terminal startup-path section', terminalSection !== undefined)
const terminalNodes = collect(terminalSection)
const terminalInput = terminalNodes.find((node) => node.type === 'input')
const saveTerminal = terminalNodes.find((node) => typeof node.props?.children === 'string'
  && node.props.children.startsWith('保存'))
check('it offers an input', terminalInput !== undefined)
check('it has a save control', saveTerminal !== undefined)
eq('the field is one input, not one per row', terminalNodes.filter((node) => node.type === 'input').length, 1)
eq('the save control is not repeated', terminalNodes.filter((node) => typeof node.props?.children === 'string'
  && node.props.children.startsWith('保存')).length, 1)
check('the input can be typed into directly',
  String(terminalInput?.props?.placeholder).includes('可直接输入'), String(terminalInput?.props?.placeholder))
// stay editable: a field nobody can type into reads as a broken panel (measured live).
check('the field stays editable while the current value is read',
  terminalInput?.props?.disabled !== true, String(terminalInput?.props?.disabled))
eq('but saving waits for that read', saveTerminal?.props?.disabled, true)
check('and it says so', rendered.includes('正在读取当前启动路径…'), rendered.slice(-200))
// Both directory fields sit together at the top, before the switches — one control each
// is the point, so their order is part of the contract, not incidental.
check('the two directory fields are adjacent, above the switches',
  found.indexOf(terminalSection) < found.indexOf(workdirSection)
  && found.indexOf(workdirSection) < found.indexOf(sectionIn(found, '工具')),
  `${found.indexOf(terminalSection)} / ${found.indexOf(workdirSection)} / ${found.indexOf(sectionIn(found, '工具'))}`)

console.log('\nfeedback entry')
eq('the panel offers exactly one feedback entry',
  found.filter((node) => node.props?.children === '反馈与支持').length, 1)
const feedbackLinks = found.filter((node) => node.type === 'a' && typeof node.props?.href === 'string')
eq('it links to the issue chooser', feedbackLinks.map((node) => node.props.href).join(','),
  'https://github.com/XINY11451/dsh-wsl/issues/new/choose')
eq('the link opens outside the app', feedbackLinks[0]?.props.target, '_blank')
const copyButton = found.find((node) => node.props?.children === '复制插件信息')
check('it offers a copy control', copyButton !== undefined)
// The submission guide sits beside the button, inside the panel, because that is
// where the question "where does this go" is asked.
const guideItems = found.filter((node) => node.type === 'li' && typeof node.props?.children === 'string')
for (const [name, needle] of [
  ['a title convention', '标题写明现象'],
  ['the three body parts', '正文包含三段'],
  ['where to paste the copied block', '「补充」栏粘贴上面复制的内容'],
  ['the routing to other repositories', 'SUPPORT.md'],
  ['the public-issue warning', 'Issue 是公开的'],
]) {
  check(`the guide mentions ${name}`, guideItems.some((node) => node.props.children.includes(needle)))
}
let copyThrew = null
try {
  await copyButton.props.onClick()
} catch (error) {
  copyThrew = error
}
check('copying does not throw', copyThrew === null, String(copyThrew))
eq('the clipboard received exactly one block', copiedTexts.length, 1)
const feedbackBlock = copiedTexts[0] ?? ''
for (const [name, needle] of [
  ['the self-info header', '### 插件信息（插件自动读取，可直接粘贴）'],
  ['an honest note when the version is unreadable', '版本：未能读取'],
  ['the panel switch states', '### 面板开关状态'],
  ['the guard row as rendered', '- 危险命令守卫：开'],
  ['the workdir row as rendered', '- 默认跟随会话工作区：开'],
  ['a line for the DSH version', '- DSH：'],
]) {
  check(`the copied block contains ${name}`, feedbackBlock.includes(needle), feedbackBlock.slice(0, 120))
}
// No clipboard API: the same control must degrade, not throw.
context.navigator = undefined
let manualThrew = null
try {
  await copyButton.props.onClick()
} catch (error) {
  manualThrew = error
}
check('a browser without a clipboard API still does not throw', manualThrew === null, String(manualThrew))
eq('nothing else was copied in that case', copiedTexts.length, 1)
// With the Host half answering, the block carries the plugin's own facts — this is
// what "the plugin reads its own information" means in practice.
context.navigator = {
  clipboard: {
    writeText: (text) => {
      copiedTexts.push(text)
      return Promise.resolve()
    },
  },
}
const askedUrls = []
context.fetch = (url) => {
  askedUrls.push(String(url))
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      name: 'dsh-wsl-tool',
      version: '9.9.9',
      repository: 'https://github.com/XINY11451/dsh-wsl.git',
      node: 'v24.0.0',
      platform: 'win32',
      arch: 'x64',
      dsh: { name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' },
      wsl: {
        defaultDistro: 'Ubuntu-22.04',
        kernel: 'Linux 6.6.87.2-microsoft-standard-WSL2 x86_64',
        capabilities: ['systemd ✓', 'docker ✗'],
      },
      config: { tools: { wsl: true }, distro: 'Ubuntu-22.04', commandTimeoutMs: 600000 },
    }),
  })
}
try {
  await copyButton.props.onClick()
} catch (error) {
  check('the copy control survives the Host answer', false, String(error))
}
eq('it asks the Host half on the documented route', askedUrls.join(','), '/dsh-wsl-tool/info')
eq('the clipboard received the second block', copiedTexts.length, 2)
const hostBlock = copiedTexts[1] ?? ''
for (const [name, needle] of [
  ['the version read from the manifest', 'dsh-wsl-tool 9.9.9'],
  ['the repository', 'https://github.com/XINY11451/dsh-wsl.git'],
  ['the runtime', 'Node v24.0.0'],
  ['the DSH build the plugin runs inside', '- DSH：0.2.0-rc.2（@deepseek-ai/dsh-desktop）'],
  ['the default distribution', 'Ubuntu-22.04（默认发行版）'],
  ['the kernel', '内核 Linux 6.6.87.2-microsoft-standard-WSL2 x86_64'],
  ['the capability flags', 'WSL 能力：systemd ✓　docker ✗'],
  ['the effective distro', 'Ubuntu-22.04'],
  ['the effective timeout', '- 命令超时 timeoutMs：600000 毫秒'],
]) {
  check(`the Host answer puts ${name} in the block`, hostBlock.includes(needle), hostBlock.slice(0, 200))
}
check('a readable block never claims anything is unreadable',
  !hostBlock.includes('未能读取'), hostBlock.slice(0, 200))

console.log('\ndegradation')
for (const [name, broken] of [
  ['a context with no slots service', {}],
  ['a context with no configForms', { slots: ctx.slots, inject: undefined }],
  ['a context whose configuration row is not served', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => { throw new Error('no such row') } },
      effect: () => () => {},
    }),
  }],
  ['a configForms face without whileServed', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => scope },
      effect: () => () => {},
    }),
  }],
  ['a namespace that never becomes served', {
    slots: ctx.slots,
    inject: (_deps, callback) => callback({
      configForms: { get: () => scope, whileServed: () => () => {} },
      effect: () => () => {},
    }),
  }],
]) {
  let error = null
  try {
    mod.apply(broken)
  } catch (caught) {
    error = caught
  }
  check(`apply survives ${name}`, error === null, String(error))
}

// A namespace the Host has not listed YET must read as "waiting", never as "this
// DSH does not provide it": the shipped panel said the latter while the Host was
// already serving the namespace, which sent the first diagnosis the wrong way.
console.log('\npending reads as waiting, not as absent')
const pendingRegistered = []
const pendingCtx = {
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      pendingRegistered.push({ seat, component })
      return () => {}
    },
  },
  inject: (_deps, callback) => callback({
    configForms: { get: () => scope, whileServed: () => () => {} },
    effect: () => () => {},
  }),
}
mod.apply(pendingCtx)
const pendingMain = pendingRegistered.find((r) => r.seat.name === 'main')
const pendingProps = typeof pendingMain?.seat.inject === 'function' ? pendingMain.seat.inject() : {}
let pendingTree = null
try {
  pendingTree = pendingMain.component({ ...pendingProps })
} catch (error) {
  check('the pending panel renders', false, String(error))
}
const pendingTexts = []
const collectPending = (node) => {
  if (typeof node === 'string') {
    pendingTexts.push(node)
    return
  }
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) collectPending(child)
    return
  }
  collectPending(node.props?.children)
}
collectPending(pendingTree)
const pendingText = pendingTexts.join('\n')
check('a not-yet-served namespace says it is waiting', /正在等待 Host/.test(pendingText), pendingText.slice(0, 120))
check('it does not claim the DSH has no such scope', !/未提供该插件的配置作用域/.test(pendingText))
check('the waiting note names the row being waited for', pendingText.includes('tool-wsl'))

// --- the terminal startup path, driven through a stateful mount -------------
//
// The recording stubs above cannot re-render, and the interesting behaviour here
// happens AFTER an async answer: the current value is filled in, a save reports its
// outcome, a failed save has to say so. This tiny mount keeps the panel's own state and
// renders again on every setState — just enough to read what the panel shows once a
// round trip has settled. Only the two state hooks are swapped, and only while mounted.
function mountStateful(component, props) {
  const cells = []
  const scheduled = []
  const deps = []
  const cleanups = []
  let cursor = 0
  let tree = null
  let live = true
  const previous = { useState: react.useState, useEffect: react.useEffect }
  const render = () => {
    cursor = 0
    tree = component(props)
    return tree
  }
  react.useState = (initial) => {
    const slot = cursor
    cursor += 1
    if (!(slot in cells)) cells[slot] = typeof initial === 'function' ? initial() : initial
    return [cells[slot], (next) => {
      if (!live) return
      cells[slot] = typeof next === 'function' ? next(cells[slot]) : next
      render()
    }]
  }
  react.useEffect = (fn, list) => {
    const slot = cursor
    cursor += 1
    const before = deps[slot]
    const again = list === undefined || !Array.isArray(before)
      || before.length !== list.length
      || list.some((value, index) => !Object.is(value, before[index]))
    if (again) {
      deps[slot] = list
      scheduled.push({ slot, fn })
    }
  }
  // Run pending effects and let their promises settle, repeatedly: an effect that sets
  // state renders again, and that render may schedule another effect.
  const flush = async () => {
    for (let round = 0; round < 20 && scheduled.length > 0; round += 1) {
      while (scheduled.length > 0) {
        const job = scheduled.shift()
        const cleanup = job.fn()
        if (typeof cleanup === 'function') cleanups[job.slot] = cleanup
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  render()
  return {
    tree: () => tree,
    flush,
    unmount: () => {
      live = false
      for (const cleanup of cleanups) {
        try {
          if (typeof cleanup === 'function') cleanup()
        } catch {}
      }
      react.useState = previous.useState
      react.useEffect = previous.useEffect
    },
  }
}

/** The text a subtree renders, joined — the panel's own "what does it say". */
const textOf = (node) => {
  const out = []
  const gather = (current) => {
    if (typeof current === 'string') {
      out.push(current)
      return
    }
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) gather(child)
      return
    }
    gather(current.props?.children)
  }
  gather(node)
  return out.join('\n')
}

/** The terminal startup field of whatever tree is current: its input and its 保存. */
const fieldIn = (root) => {
  const area = sectionIn(collect(root), 'WSL 终端启动路径')
  const inner = area === undefined ? [] : collect(area)
  return {
    input: inner.find((node) => node.type === 'input'),
    save: inner.find((node) => typeof node.props?.children === 'string'
      && node.props.children.startsWith('保存')),
  }
}

console.log('\nterminal startup path: the async flow')
const requested = []
let getAnswer = { path: '/mnt/d/current', available: true, error: null }
let postAnswer = { ok: true, path: '/mnt/d/next', error: null }
context.fetch = (url, options) => {
  const method = options !== undefined && options.method !== undefined ? options.method : 'GET'
  requested.push({ url: String(url), method, body: options?.body, headers: options?.headers })
  const answer = method === 'POST' ? postAnswer : getAnswer
  if (answer === 'reject') return Promise.reject(new Error('offline'))
  return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) })
}
const panelProps = typeof main?.seat.inject === 'function' ? main.seat.inject() : {}
const terminalCalls = () => requested.filter((entry) => entry.url === '/dsh-wsl-tool/terminal-cwd')
// Every settings-scope write so far; a terminal save must not add to this list.
const settingsWritesBefore = ops.length

// (1) Mount: the current value comes from the Host and opens in the field.
const mounted = mountStateful(main.component, { ...panelProps })
check('the stateful panel renders', mounted.tree() !== null)
await mounted.flush()
eq('it asks the Host once for the current startup path', terminalCalls().length, 1)
eq('and it asks with GET', terminalCalls()[0]?.method, 'GET')
const filled = fieldIn(mounted.tree())
eq('the field shows the current value', filled.input?.props?.value, '/mnt/d/current')

// (2) A save POSTs the typed directory, and the panel says a restart is needed.
filled.input.props.onChange({ target: { value: '/mnt/d/next' } })
const edited = fieldIn(mounted.tree())
eq('the field is controlled: typing shows the typed value', edited.input?.props?.value, '/mnt/d/next')
postAnswer = { ok: true, path: '/mnt/d/next', error: null }
const savedTerminal = await edited.save.props.onClick()
check('the save settles as successful', savedTerminal === true, String(savedTerminal))
const posted = terminalCalls().filter((entry) => entry.method === 'POST').pop()
eq('the save POSTs to the Host route', posted?.url, '/dsh-wsl-tool/terminal-cwd')
eq('the save sends the typed directory', JSON.parse(posted?.body).path, '/mnt/d/next')
// The Host route refuses anything but JSON (that is its cross-site gate), so the panel
// sending this exact content type is part of the contract, not an incidental header.
check('the save asks for JSON', /application\/json/.test(String(posted?.headers?.['content-type'])),
  JSON.stringify(posted?.headers))
const savedText = textOf(mounted.tree())
check('the panel says the change needs a restart', savedText.includes('重启 DSH 后生效'), savedText.slice(-200))
// The value lives in the profile patch, so the settings scope must NOT have been written
// to: a save that went through `configForms` would write a config field that no Host half
// reads, and the panel would look like it worked while nothing changed.
eq('the terminal save writes the patch, not the settings scope', ops.length, settingsWritesBefore)

// (2b) A saved value settles to what the Host stored, not to the raw text that was typed: the
// field must not keep showing whitespace that was trimmed away, nor an empty box for a path
// that is set.
const padded = fieldIn(mounted.tree())
padded.input.props.onChange({ target: { value: '  /mnt/d/padded  ' } })
postAnswer = { ok: true, path: '/mnt/d/padded', error: null }
await fieldIn(mounted.tree()).save.props.onClick()
eq('a saved path settles to the stored value', fieldIn(mounted.tree()).input?.props?.value, '/mnt/d/padded')

// (3) A refused save shows the Host's reason instead of pretending it worked.
const retry = fieldIn(mounted.tree())
retry.input.props.onChange({ target: { value: '/mnt/d/nowhere' } })
postAnswer = { ok: false, path: '', error: '这个 profile 的 patch 里没有指向 WSL 的侧边栏终端，没有可改的行' }
const refusedTerminal = await fieldIn(mounted.tree()).save.props.onClick()
check('a refused save settles as failed', refusedTerminal === false, String(refusedTerminal))
const refusedText = textOf(mounted.tree())
check('the panel shows why the save failed',
  refusedText.includes('保存失败') && refusedText.includes('没有可改的行'), refusedText.slice(-240))
/** The terminal history field of whatever tree is current: its input and its 保存. */
const historyFieldIn = (root) => {
  const area = sectionIn(collect(root), '终端历史行数')
  const inner = area === undefined ? [] : collect(area)
  return {
    input: inner.find((node) => node.type === 'input'),
    save: inner.find((node) => typeof node.props?.children === 'string'
      && node.props.children.startsWith('保存')),
  }
}

// (5) The same row also carries how much history its terminal keeps. Same route, same
// rules, one property per save — and the panel has to say a restart is needed, because
// that row is read when the composition is built.
console.log('\nterminal history length: the same route, one property per save')
getAnswer = { path: '/mnt/d/current', scrollback: null, available: true, error: null }
const historyMounted = mountStateful(main.component, { ...panelProps })
await historyMounted.flush()
const historyField = historyFieldIn(historyMounted.tree())
check('the panel offers a history-length field',
  historyField.input !== undefined && historyField.save !== undefined, textOf(historyMounted.tree()).slice(-240))
eq('an unset history length leaves the box empty', historyField.input?.props?.value, '')
// The platform's own default, from the shipped terminal-controller schema
// (`scrollback: z.number().step(1).min(0).default(1e3)`). Named here so the assertion is a
// cross-check against the platform rather than a copy of the panel's own string.
const PLATFORM_SCROLLBACK_DEFAULT = 1000
check('and the placeholder names the platform default',
  String(historyField.input?.props?.placeholder).includes(String(PLATFORM_SCROLLBACK_DEFAULT)),
  String(historyField.input?.props?.placeholder))
const historyWritesBefore = ops.length
historyField.input.props.onChange({ target: { value: '5000' } })
eq('the field is controlled: typing shows the typed value',
  historyFieldIn(historyMounted.tree()).input?.props?.value, '5000')
postAnswer = { ok: true, path: '/mnt/d/current', scrollback: 5000, error: null }
const savedHistory = await historyFieldIn(historyMounted.tree()).save.props.onClick()
check('the save settles as successful', savedHistory === true, String(savedHistory))
const historyPost = terminalCalls().filter((entry) => entry.method === 'POST').pop()
eq('the save sends only the scrollback property',
  JSON.stringify(JSON.parse(historyPost?.body)), JSON.stringify({ scrollback: '5000' }))
const historyText = textOf(historyMounted.tree())
check('the panel confirms the saved length and the restart',
  historyText.includes('已保存：5000 行') && historyText.includes('重启 DSH 后生效'), historyText.slice(-240))
eq('the history save writes the patch, not the settings scope', ops.length, historyWritesBefore)
postAnswer = { ok: false, path: '/mnt/d/current', scrollback: null, error: '历史行数只能填数字' }
historyFieldIn(historyMounted.tree()).input.props.onChange({ target: { value: 'many' } })
const refusedHistory = await historyFieldIn(historyMounted.tree()).save.props.onClick()
check('a refused history save settles as failed', refusedHistory === false, String(refusedHistory))
check('and the panel shows the Host\'s reason',
  textOf(historyMounted.tree()).includes('历史行数只能填数字'), textOf(historyMounted.tree()).slice(-240))
historyMounted.unmount()

mounted.unmount()

// (4) A profile without the terminal row: the panel points at the opt-in instead of
// offering a save that the Host would refuse for a reason the user cannot act on.
getAnswer = { path: '', available: false, error: null }
const missingRow = mountStateful(main.component, { ...panelProps })
await missingRow.flush()
check('a profile without the terminal row points at the opt-in',
  textOf(missingRow.tree()).includes('当前配置未启用 WSL 终端'), textOf(missingRow.tree()).slice(-240))
eq('and saving is withheld until that opt-in exists', fieldIn(missingRow.tree()).save?.props?.disabled, true)
check('while the field itself stays editable',
  fieldIn(missingRow.tree()).input?.props?.disabled !== true,
  String(fieldIn(missingRow.tree()).input?.props?.disabled))
missingRow.unmount()

// (4b) The Host answered `available: false` WITH a reason — the exact payload a host that
// cannot name its patch file produces. That is a read failure, not a missing opt-in, and
// the panel must not send the reader after the recipe; the field stays typeable either way.
getAnswer = { path: '', available: false, error: '宿主既没有 profileContext.patchPath 也没有 DSH_PROFILE_DIR，读不到 profile 的 patch 文件' }
const unresolved = mountStateful(main.component, { ...panelProps })
await unresolved.flush()
const unresolvedText = textOf(unresolved.tree())
check('a host that cannot name the patch file reports that reason',
  unresolvedText.includes('读取失败') && unresolvedText.includes('profileContext'),
  unresolvedText.slice(-260))
check('and it is not dressed up as a missing opt-in',
  !unresolvedText.includes('当前配置未启用 WSL 终端'), unresolvedText.slice(-260))
check('the field is still typeable in that state',
  fieldIn(unresolved.tree()).input?.props?.disabled !== true,
  String(fieldIn(unresolved.tree()).input?.props?.disabled))
unresolved.unmount()

// (7) A Host that never lists the namespace at all — the state a fresh profile lands in
// when `@deepseek-ai/schemastery` is absent, which is an OPTIONAL peer and so may not be
// installed. The wait is bounded, and past it the panel names the cause instead of
// spinning: the tools and this terminal field do not depend on that schema.
const unservedRegistered = []
mod.apply({
  slots: {
    inject: (_seat, callback) => callback(),
    register: (seat, component) => {
      unservedRegistered.push({ seat, component })
      return () => {}
    },
  },
  inject: (_deps, callback) => callback({
    configForms: { get: () => scope, whileServed: () => () => {} },
    effect: () => () => {},
  }),
})
const unservedMain = unservedRegistered.find((row) => row.seat.name === 'main')
const unserved = mountStateful(unservedMain.component, { ...(unservedMain.seat.inject()) })
await unserved.flush()
check('an entry the Host never serves first reports that it is waiting',
  textOf(unserved.tree()).includes('正在等待 Host'), textOf(unserved.tree()).slice(-200))
fireTimers((timer) => timer.ms >= 5000)
const expiredText = textOf(unserved.tree())
check('past the bounded wait it names the missing schema peer',
  expiredText.includes('schemastery') && expiredText.includes('未提供该插件的配置作用域'), expiredText.slice(-260))
check('and says what still works', expiredText.includes('不受影响'), expiredText.slice(-260))
check('the terminal field is still rendered in that state', fieldIn(unserved.tree()).input !== undefined)
unserved.unmount()

// A write the scope REFUSES must be visible. Without this the suite would pass even if the
// panel ignored `mutate`'s answer and showed a switch as saved.
console.log('\na refused scope write')
scopeAccepts = false
const refusedMount = mountStateful(main.component, { ...panelProps })
await refusedMount.flush()
const refusedSwitch = collect(refusedMount.tree()).find((node) => node.props?.label === 'wsl 命令执行')
check('the refused-write mount still renders the switch', refusedSwitch !== undefined)
const refusedLanded = await refusedSwitch.props.onChange(false)
check('a refused write settles as failed', refusedLanded === false, String(refusedLanded))
check('and the panel says the configuration was not written',
  textOf(refusedMount.tree()).includes('保存失败：配置未写入'), textOf(refusedMount.tree()).slice(-240))
refusedMount.unmount()
scopeAccepts = true

// (5) The route cannot be reached at all: degrade to a note, never throw — and BOTH fields
// must degrade. A field left in 'loading' keeps its 保存 disabled forever, which reads as a
// broken panel rather than a failed read.
getAnswer = 'reject'
const offline = mountStateful(main.component, { ...panelProps })
await offline.flush()
check('an unreachable route degrades to a note',
  textOf(offline.tree()).includes('读取失败'), textOf(offline.tree()).slice(-240))
check('the field is still offered when the read failed', fieldIn(offline.tree()).input !== undefined)
check('a failed read does not brick the history field either',
  historyFieldIn(offline.tree()).input !== undefined, textOf(offline.tree()).slice(-240))
eq('and its save is not disabled', historyFieldIn(offline.tree()).save?.props?.disabled, false)
check('and the panel says why that field could not be read',
  /当前值读取失败/.test(textOf(offline.tree())), textOf(offline.tree()).slice(-240))
offline.unmount()

// (6) A browser with no fetch at all: the same degradation, and no exception.
const realFetch = context.fetch
context.fetch = undefined
const noFetch = mountStateful(main.component, { ...panelProps })
await noFetch.flush()
check('a browser without fetch still renders the field',
  textOf(noFetch.tree()).includes('当前环境无法读取设置值'), textOf(noFetch.tree()).slice(-200))
check('and that panel offers a save control too', fieldIn(noFetch.tree()).save !== undefined)
noFetch.unmount()
context.fetch = realFetch

// --- the subtask dock above the composer -------------------------------------
//
// It reads the Host's subtask log and renders one line per subtask, with the commands behind
// a click. Three states have to stay distinct: rows, a readable log with nothing in it (one
// faint line, because a display that only appears after the first subtask reads as missing),
// and a log that could not be read at all (silent — it must not claim there were none).
console.log('\nthe subtask dock above the composer')
const dock = registered.find((row) => row.seat.id === 'wsl-subtasks')
check('it registers a row in the composer dock', dock !== undefined)
eq('the row sits after the app\'s own dock entries', dock?.seat.order, 30)
const dockFetch = context.fetch
{
  const payload = {
    total: 2,
    running: 1,
    entries: [
      {
        id: '2', title: '跑通 sta 流程', status: 'running', result: null, terminal: 'attached',
        terminalCreated: true, terminalId: 'dsh-agent',
        terminalInfo: {
          id: 'dsh-agent', title: 'WSL', shell: 'WSL', args: ['-d', 'Ubuntu-22.04', '-e', 'bash'],
          cwd: 'D:\\DSHworkarea', cols: 120, rows: 30, state: 'running', stale: false,
        },
        commands: [{ command: 'make sta', exitCode: 0 }], finishedAt: null,
      },
      {
        id: '1', title: '修终端就绪竞态', status: 'done', result: '已修', terminal: 'closed',
        terminalCreated: true, terminalId: 'dsh-1', terminalInfo: null,
        commands: [{ command: 'node test/smoke.mjs', exitCode: 0 }], finishedAt: 1,
      },
    ],
  }
  context.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: { 'session-1': payload } }) })
  const mounted = mountStateful(dock.component, { sessionId: 'session-1' })
  eq('before the first answer it says nothing at all', textOf(mounted.tree()), '')
  await mounted.flush()
  const text = textOf(mounted.tree())
  check('the dock names the running subtask', text.includes('跑通 sta 流程') && text.includes('运行中'), text)
  check('and says how many this conversation ran', text.includes('共 2 个') && text.includes('运行 1'), text)
  check('a finished subtask is marked done', text.includes('修终端就绪竞态') && text.includes('已结束·关闭'), text)
  check('commands stay hidden until the subtask is opened',
    !text.includes('make sta') && !text.includes('node test/smoke.mjs'), text)
  const clickables = collect(mounted.tree()).filter((node) => typeof node.props?.onClick === 'function')
  eq('one click target per subtask', clickables.length, 2)
  clickables[0].props.onClick()
  const opened = textOf(mounted.tree())
  check('opening a subtask shows the command it ran', opened.includes('$ make sta') && opened.includes('→ 0'), opened)
  check('and the whole terminal it ran in',
    opened.includes('dsh-agent') && opened.includes('Ubuntu-22.04') && opened.includes('120x30'),
    opened)
  clickables[1].props.onClick()
  const second = textOf(mounted.tree())
  check('opening a finished subtask shows its result', second.includes('结果：已修'), second)
  mounted.unmount()

  // A readable log with nothing in it: one faint line, and no card around it.
  context.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: {} }) })
  const empty = mountStateful(dock.component, { sessionId: 'session-1' })
  await empty.flush()
  eq('an empty log says so in one line', textOf(empty.tree()), '暂无子任务')
  check('and that line is faint, with no container around it',
    Number(empty.tree()?.props?.style?.opacity) < 0.8
    && empty.tree()?.props?.style?.border === undefined
    && empty.tree()?.props?.style?.background === undefined,
    JSON.stringify(empty.tree()?.props?.style))
  empty.unmount()

  // A log that cannot be read: silent. Saying "no subtasks" here would be a lie.
  context.fetch = () => Promise.reject(new Error('offline'))
  const broken = mountStateful(dock.component, { sessionId: 'session-1' })
  await broken.flush()
  eq('a log that could not be read stays silent', textOf(broken.tree()), '')
  broken.unmount()

  // No session id at all (the dock mounted before the session resolved): also silent.
  context.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: { 'session-1': payload } }) })
  const noSession = mountStateful(dock.component, {})
  await noSession.flush()
  eq('without a session it renders nothing', textOf(noSession.tree()), '')
  noSession.unmount()
}
context.fetch = dockFetch

// --- the terminal bridge (the browser half of wsl-term collaboration) -------
//
// DSH 0.2.1 removed `terminalController.follow`/`write`: a Host plugin has no Remote
// invocation, so it cannot drive a browser terminal by itself any more. The Host half
// therefore parks what it wants done as commands, and this page — which does own a Remote
// invocation — executes them against `webTerminals` and streams the frames back. That loop
// is the only thing that keeps a user-visible terminal in the loop, so every shape below is
// asserted against the contract (`_term-bridge-contract.md`) rather than against the code:
// one poll route, one event route, an ack after every render frame, dispose (never close) on
// detach, and silence when the service or the routes are absent.

console.log('\nthe terminal bridge')
const settleBridge = () => new Promise((resolve) => setImmediate(resolve))
const BRIDGE_POLL_URL = '/dsh-wsl-tool/term-bridge/poll'
const BRIDGE_EVENTS_URL = '/dsh-wsl-tool/term-bridge/events'

/** One fake terminal view: a subscribable store plus the calls the worker must make. */
function makeBridgeView() {
  const listeners = new Set()
  const store = {
    value: {
      phase: 'connected',
      writable: true,
      info: { id: 't-1', title: 'WSL', state: 'running', cols: 120, rows: 30 },
      render: undefined,
    },
    getSnapshot() { return this.value },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    state: store,
    mounts: 0,
    writes: [],
    acks: [],
    disposes: 0,
    closes: 0,
    listenCount: () => listeners.size,
    mount() {
      this.mounts += 1
      return () => {}
    },
    write(data) { this.writes.push(data) },
    acknowledge(revision) { this.acks.push(revision) },
    dispose() {
      this.disposes += 1
      return Promise.resolve()
    },
    close() {
      this.closes += 1
      return Promise.resolve()
    },
    patch(next) {
      store.value = { ...store.value, ...next }
      for (const listener of Array.from(listeners)) listener(store.value)
    },
  }
}

/** A fake `fetch` for the two bridge routes, with a command queue the test refills. */
function makeBridgeFetch() {
  const calls = []
  const commands = []
  let parked = undefined
  const fetcher = (url, init) => {
    const target = String(url)
    calls.push({ url: target, init: init ?? {}, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    if (target === BRIDGE_POLL_URL) {
      const batch = commands.splice(0, commands.length)
      if (batch.length > 0) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, commands: batch, ttlMs: 15000 }),
        })
      }
      // Park the long poll: the worker only advances when a command is pushed.
      return new Promise((resolve) => {
        parked = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, commands: [], ttlMs: 15000 }) })
      })
    }
    if (target === BRIDGE_EVENTS_URL) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
  }
  const eventCalls = () => calls.filter((call) => call.url === BRIDGE_EVENTS_URL)
  return {
    fetcher,
    calls,
    pollCalls: () => calls.filter((call) => call.url === BRIDGE_POLL_URL),
    eventCalls,
    events: () => eventCalls().flatMap((call) => (Array.isArray(call.body?.events) ? call.body.events : [])),
    push(command) {
      commands.push(command)
      if (parked !== undefined) {
        const wake = parked
        parked = undefined
        wake()
      }
    },
  }
}

/** Apply the module against a fake client context whose terminal service is this stub. */
function applyBridge(options) {
  const previousFetch = context.fetch
  context.fetch = options.fetch
  const disposers = []
  let threw = null
  const ctx = {
    slots: { inject: (_seat, callback) => callback(), register: () => () => {} },
    inject: (deps, callback) => {
      if (deps.includes('webTerminals')) {
        callback({
          webTerminals: options.webTerminals,
          effect: (setup) => {
            const dispose = setup()
            disposers.push(dispose)
            return () => {}
          },
        })
        return
      }
      callback({
        configForms: {
          get: () => scope,
          whileServed: (_namespaces, register) => {
            const off = register(new Set())
            return () => { if (typeof off === 'function') off() }
          },
        },
        effect: () => () => {},
      })
    },
  }
  try {
    mod.apply(ctx)
  } catch (error) {
    threw = error
  }
  return {
    threw,
    restore: () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {}
      }
      context.fetch = previousFetch
    },
  }
}

/** Fire the bridge's 50 ms event-flush timer, then let its request settle. */
const flushBridgeEvents = async () => {
  fireTimers((timer) => timer.ms === 50)
  await settleBridge()
  await settleBridge()
}

// (1) The service is served: one long poll, JSON, with a client id and the current
// attachment list. Nothing is attached on the first poll.
{
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const applied = applyBridge({ webTerminals: { view: () => view }, fetch: bridgeFetch.fetcher })
  eq('the bridge starts without throwing', applied.threw, null)
  await settleBridge()
  const polls = bridgeFetch.pollCalls()
  eq('the page long-polls the bridge route', polls.length, 1)
  eq('the poll is a POST', polls[0]?.init?.method, 'POST')
  check('the poll asks for JSON', /application\/json/.test(String(polls[0]?.init?.headers?.['content-type'])),
    JSON.stringify(polls[0]?.init?.headers))
  check('the poll carries one 16-32 hex client id',
    /^[0-9a-f]{16,32}$/.test(String(polls[0]?.body?.clientId)), String(polls[0]?.body?.clientId))
  eq('the poll starts with no attachments', JSON.stringify(polls[0]?.body?.attachments), '[]')
  applied.restore()
}

// (2) No terminal service in this composition: the Host falls back to its own PTY, and the
// page must not start a poll loop against routes it cannot serve.
{
  const bridgeFetch = makeBridgeFetch()
  const applied = applyBridge({ webTerminals: undefined, fetch: bridgeFetch.fetcher })
  await settleBridge()
  eq('without the terminal service nothing polls', bridgeFetch.calls.length, 0)
  eq('and apply still mounts', applied.threw, null)
  applied.restore()
}

// (3) A browser with no fetch at all: the same degradation, and no exception.
{
  const applied = applyBridge({ webTerminals: { view: () => makeBridgeView() }, fetch: undefined })
  eq('a page without fetch does not take apply down', applied.threw, null)
  applied.restore()
}

// (4) An older Host has no bridge routes: 404 is final, not a retry loop.
{
  let pollCount = 0
  const fetcher = (url) => {
    if (String(url) === BRIDGE_POLL_URL) {
      pollCount += 1
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  }
  const applied = applyBridge({ webTerminals: { view: () => makeBridgeView() }, fetch: fetcher })
  await settleBridge()
  eq('a Host without bridge routes is polled once', pollCount, 1)
  await settleBridge()
  await settleBridge()
  eq('a 404 stops the loop permanently', pollCount, 1)
  applied.restore()
}

// (5) The whole loop, one attachment: attach, screen frames, input, read-only input,
// detach. The order matters — frames must arrive in the order the terminal produced them,
// each one acknowledged, and input only while the user has not taken the keyboard.
{
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const opened = []
  const applied = applyBridge({
    webTerminals: {
      view: (...args) => {
        opened.push(args)
        return view
      },
    },
    fetch: bridgeFetch.fetcher,
  })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-1', sessionId: 's-1', terminalId: 't-1' })
  await settleBridge()
  eq('an attach opens one view per attachment',
    JSON.stringify(opened[0]), JSON.stringify(['s-1', 'dsh-wsl-bridge:a-1', 'dsh-wsl-bridge:a-1', 't-1']))
  eq('and mounts it', view.mounts, 1)
  check('the attachment is announced to the next poll',
    bridgeFetch.pollCalls().some((call) => JSON.stringify(call.body?.attachments) === '["a-1"]'),
    JSON.stringify(bridgeFetch.pollCalls().map((call) => call.body?.attachments)))
  await flushBridgeEvents()
  const attachResult = bridgeFetch.events().find((event) => event.type === 'result' && event.commandId === 'c-1')
  eq('the attach is acknowledged with a result', attachResult?.ok, true)
  eq('the first state event carries the view writable flag',
    JSON.stringify(bridgeFetch.events().filter((event) => event.type === 'state').map((event) => event.writable)), '[true]')

  // A snapshot frame: the whole screen, with the info and writable flag the Host needs.
  view.patch({
    render: {
      revision: 1,
      frame: {
        type: 'snapshot',
        screen: '\u001b[32mready\u001b[0m',
        info: { id: 't-1', title: 'WSL', state: 'running', cols: 120, rows: 30 },
        writable: true,
      },
    },
  })
  await flushBridgeEvents()
  const snapshot = bridgeFetch.events().find((event) => event.type === 'snapshot')
  eq('a snapshot frame becomes one snapshot event', snapshot?.screen, '\u001b[32mready\u001b[0m')
  eq('with the terminal info the Host reads', snapshot?.info?.cols, 120)
  check('the snapshot frame is acknowledged', view.acks.includes(1), JSON.stringify(view.acks))

  // An output frame: only the new text.
  view.patch({ render: { revision: 2, frame: { type: 'output', data: 'hello' } } })
  await flushBridgeEvents()
  const output = bridgeFetch.events().find((event) => event.type === 'output')
  eq('an output frame becomes one output event', output?.data, 'hello')
  eq('every render revision is acknowledged exactly once', JSON.stringify(view.acks), '[1,2]')

  // Input while the user still lets the tool type.
  bridgeFetch.push({ id: 'c-2', kind: 'write', attachmentId: 'a-1', data: 'ls -la\r' })
  await settleBridge()
  await flushBridgeEvents()
  eq('a write command reaches the view with its raw keys', JSON.stringify(view.writes), '["ls -la\\r"]')
  const wrote = bridgeFetch.events().find((event) => event.type === 'result' && event.commandId === 'c-2')
  eq('and settles as a successful result', wrote?.ok, true)

  // The user clicked "take input": writable changes, and a write now fails instead of
  // pretending it typed something.
  view.patch({ writable: false })
  await flushBridgeEvents()
  eq('a writable change is reported as another state event',
    JSON.stringify(bridgeFetch.events().filter((event) => event.type === 'state').map((event) => event.writable)),
    '[true,false]')
  bridgeFetch.push({ id: 'c-3', kind: 'write', attachmentId: 'a-1', data: 'rm -rf /\r' })
  await settleBridge()
  await flushBridgeEvents()
  const refused = bridgeFetch.events().find((event) => event.type === 'result' && event.commandId === 'c-3')
  eq('writing a read-only view fails', refused?.ok, false)
  eq('with the contract\'s reason', refused?.error, 'the terminal is read-only (the user took keyboard control)')
  eq('and nothing is written once control was taken', view.writes.length, 1)

  // Detach releases the bridge's hold on the view — it never closes the user's terminal.
  bridgeFetch.push({ id: 'c-4', kind: 'detach', attachmentId: 'a-1' })
  await settleBridge()
  await flushBridgeEvents()
  const detached = bridgeFetch.events().find((event) => event.type === 'result' && event.commandId === 'c-4')
  eq('a detach command succeeds', detached?.ok, true)
  eq('it disposes the view once', view.disposes, 1)
  eq('it never closes the user\'s terminal', view.closes, 0)
  eq('it unsubscribes from the view store', view.listenCount(), 0)
  await settleBridge()
  eq('the released attachment is omitted from the next poll',
    JSON.stringify(bridgeFetch.pollCalls().pop()?.body?.attachments), '[]')
  applied.restore()
}

// (5b) The Host may have created the terminal a moment ago (the tool opens one when the session
// has none), and the page's terminal list is a shared cache: without a refresh the new terminal is
// invisible and `view()` fails as `missingTerminal`. The attach must therefore ask the service to
// refresh that list — `recover(sessionId, true)` — before it opens the view.
{
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const order = []
  const applied = applyBridge({
    webTerminals: {
      recover: (sessionId, refresh) => {
        order.push(['recover', sessionId, refresh])
        return Promise.resolve([])
      },
      view: (...args) => {
        order.push(['view', ...args])
        return view
      },
    },
    fetch: bridgeFetch.fetcher,
  })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-9', sessionId: 's-9', terminalId: 'dsh-agent' })
  await settleBridge()
  await settleBridge()
  eq('attach refreshes the cached terminal list first',
    JSON.stringify(order[0]), JSON.stringify(['recover', 's-9', true]))
  eq('and only then opens the view', order[1]?.[0], 'view')
  eq('the attach still mounts and succeeds', view.mounts, 1)
  applied.restore()
}

// (5c) A refused refresh must not fail the attach: the refresh is an optimization, and the view
// itself reports the real problem.
{
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const applied = applyBridge({
    webTerminals: {
      recover: () => Promise.reject(new Error('list refused')),
      view: () => view,
    },
    fetch: bridgeFetch.fetcher,
  })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-8', sessionId: 's-8', terminalId: 't-8' })
  await settleBridge()
  await settleBridge()
  eq('a refused list refresh still attaches', view.mounts, 1)
  applied.restore()
}

// (6) A view that fails (the terminal was closed or vanished): one error event, once.
{
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const applied = applyBridge({ webTerminals: { view: () => view }, fetch: bridgeFetch.fetcher })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-9', sessionId: 's-1', terminalId: 't-9' })
  await settleBridge()
  view.patch({ phase: 'failed', error: 'terminal t-9 is gone' })
  await flushBridgeEvents()
  const failures = bridgeFetch.events().filter((event) => event.type === 'error')
  eq('a failed view reports an error event', failures.length, 1)
  eq('for the right attachment', failures[0]?.attachmentId, 'a-9')
  check('naming why the connection ended', String(failures[0]?.message).includes('terminal t-9 is gone'),
    String(failures[0]?.message))
  view.patch({ phase: 'failed', error: 'a second patch' })
  await flushBridgeEvents()
  eq('a repeated failed patch does not repeat the error',
    bridgeFetch.events().filter((event) => event.type === 'error').length, 1)
  applied.restore()
}

// (7) A view that refuses to open: the command fails with a reason and apply stays up.
{
  const bridgeFetch = makeBridgeFetch()
  const applied = applyBridge({
    webTerminals: { view: () => { throw new Error('no terminal t-7 in this session') } },
    fetch: bridgeFetch.fetcher,
  })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-7', sessionId: 's-1', terminalId: 't-7' })
  await settleBridge()
  await flushBridgeEvents()
  const refused = bridgeFetch.events().find((event) => event.type === 'result' && event.commandId === 'c-1')
  eq('a view that refuses to open fails the command', refused?.ok, false)
  check('and the reason reaches the Host', String(refused?.error).includes('no terminal t-7'), String(refused?.error))
  eq('apply itself stayed up', applied.threw, null)
  applied.restore()
}

// (8) Event delivery: one retry after a network failure, then the batch is delivered.
{
  const bridgeFetch = makeBridgeFetch()
  let eventAttempts = 0
  const fetcher = (url, init) => {
    if (String(url) === BRIDGE_EVENTS_URL) {
      eventAttempts += 1
      if (eventAttempts === 1) return Promise.reject(new Error('offline'))
    }
    return bridgeFetch.fetcher(url, init)
  }
  const applied = applyBridge({ webTerminals: { view: () => makeBridgeView() }, fetch: fetcher })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-1', sessionId: 's-1', terminalId: 't-1' })
  await settleBridge()
  await flushBridgeEvents()
  eq('a failed event batch is retried once', eventAttempts, 2)
  check('and the retry delivers the command result',
    bridgeFetch.events().some((event) => event.type === 'result' && event.commandId === 'c-1'),
    JSON.stringify(bridgeFetch.events()))
  applied.restore()
}

// (9) An older store with no `subscribe`: the worker samples it instead, at 100 ms, and
// still acknowledges what it forwards.
{
  const bridgeFetch = makeBridgeFetch()
  const store = {
    value: { phase: 'connected', writable: true, info: { id: 't-1', state: 'running' }, render: undefined },
    getSnapshot() { return this.value },
  }
  const view = {
    state: store,
    mounts: 0,
    acks: [],
    disposes: 0,
    closes: 0,
    mount() {
      this.mounts += 1
      return () => {}
    },
    acknowledge(revision) { this.acks.push(revision) },
    dispose() {
      this.disposes += 1
      return Promise.resolve()
    },
    close() { this.closes += 1 },
  }
  const applied = applyBridge({ webTerminals: { view: () => view }, fetch: bridgeFetch.fetcher })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-2', sessionId: 's-1', terminalId: 't-2' })
  await settleBridge()
  store.value = {
    ...store.value,
    render: { revision: 1, frame: { type: 'snapshot', screen: 'sampled', info: store.value.info, writable: true } },
  }
  fireTimers((timer) => timer.ms === 100)
  await settleBridge()
  await flushBridgeEvents()
  const sampled = bridgeFetch.events().find((event) => event.type === 'snapshot')
  eq('a store without subscribe is sampled for frames', sampled?.screen, 'sampled')
  check('and the sampled frame is acknowledged', view.acks.includes(1), JSON.stringify(view.acks))
  applied.restore()
}

// (10) Page unload or plugin reload: the worker registers a `pagehide` hook, and that hook
// releases the attached views and stops the loop — still without closing any terminal.
{
  const added = []
  const removed = []
  context.window.addEventListener = (name, handler) => added.push({ name, handler })
  context.window.removeEventListener = (name, handler) => removed.push({ name, handler })
  const bridgeFetch = makeBridgeFetch()
  const view = makeBridgeView()
  const applied = applyBridge({ webTerminals: { view: () => view }, fetch: bridgeFetch.fetcher })
  await settleBridge()
  bridgeFetch.push({ id: 'c-1', kind: 'attach', attachmentId: 'a-1', sessionId: 's-1', terminalId: 't-1' })
  await settleBridge()
  const unload = added.find((entry) => entry.name === 'pagehide')
  check('the worker listens for page unload', unload !== undefined, JSON.stringify(added.map((entry) => entry.name)))
  const pollsBefore = bridgeFetch.pollCalls().length
  if (unload !== undefined) unload.handler()
  await settleBridge()
  eq('the unload hook releases the attached view', view.disposes, 1)
  eq('and never closes the user\'s terminal', view.closes, 0)
  eq('and stops polling', bridgeFetch.pollCalls().length, pollsBefore)
  eq('and unregisters itself', removed.filter((entry) => entry.name === 'pagehide').length, 1)
  applied.restore()
  delete context.window.addEventListener
  delete context.window.removeEventListener
}

// The documented counts are hand-written and drift on every commit; this suite knows its own
// total, so it checks the docs rather than trusting them. Compared after the totals are
// final, so it does not change the number it checks.
{
  const total = passed + failures.length
  const repoRoot = new URL('..', import.meta.url)
  const drifting = []
  for (const doc of ['README.md', 'README.zh-CN.md', 'SUPPORT.md']) {
    const text = readFileSync(new URL(doc, repoRoot), 'utf8')
    if (!text.includes(`${total} client checks`) && !text.includes(`${total} 项客户端检查`)) drifting.push(doc)
  }
  if (drifting.length > 0) {
    console.log(`\nthe docs do not document the ${total} client checks this run executed: ${drifting.join(', ')}`)
    process.exitCode = 1
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const name of failures) console.log(` - ${name}`)
  process.exitCode = 1
}
