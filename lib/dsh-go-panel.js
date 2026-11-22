// dsh-go 原生面板：破甲状态（随 dsh-purge-merged 一起分发，App 读 package.json 的 dshGo 清单）。
// local-purge: 在 dsh-go 原生界面里显示 dsh-purge-merged 的破甲状态。
// 引擎内 Node 代码，读状态文件 + 调 purge 自带 CLI 做自检；App 只画 JSON 视图。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CORE_DIR = path.join(HOME, 'dsh-purge')
const MERGED_DIR = path.join(HOME, 'dsh-purge-merged')
const INJECT_FILE = path.join(HOME, 'prompt-inject.md')
const PROFILE_PATCH = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml')
// 包根由本文件位置推导：换 profile（web / desktop / rescue / 自定义）都不用改这里。
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(PKG_ROOT, 'bin', 'community.js')
const BUNDLE_PATCH = path.join(PKG_ROOT, 'cordis.patch.yml')
const SHIM = '/usr/local/bin/dsh'
const HOST_PKG = '/opt/dsh/node_modules/@deepseek-ai/dsh/package.json'

// selfcheck 要 spawn 一个 node（本机实测 1.5s CPU），缓存放长一点，别每次开面板都跑。
const CACHE_TTL = 30 * 60 * 1000
let cache = { patch: null, pending: 0, at: 0, running: false }

// 备份 / 选中目标 / 更新检查：面板打开期间带 TTL 缓存
let backupCache = { at: 0, list: [], usage: null }
let selectedBackup = ''
let lastCheck = null

const shortId = (id) => String(id || '').replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2}).*/, '$1-$2-$3 $4:$5')

async function refreshBackups() {
  const r = await runCli(['status'], 45_000)
  const data = r?.ok ? r.data : null
  const list = Array.isArray(data?.backups) ? data.backups : []
  let usage = null
  try {
    const u = await runCli(['usage'], 20_000)
    usage = u?.ok ? u.data : null
  } catch { usage = null }
  backupCache = { at: Date.now(), list, usage }
  return backupCache
}

function bytesText(n) {
  const v = Number(n) || 0
  if (v <= 0) return '—'
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// 可在 App 原生面板里直接改的破甲配置（写回 cordis.patch.yml 的 insert.config）
const CONFIG_FIELDS = [
  ['enabled', 'bool', '启用破甲注入'],
  ['autoApplyOnStart', 'bool', '启动时自动应用补丁'],
  ['autoUpdateOnStart', 'bool', '启动时自动检查更新'],
  ['autoRevertOnMissing', 'bool', '找不到补丁时自动还原'],
  ['injectOnce', 'bool', '只注入一次'],
  ['stripMnemon', 'bool', '清掉宿主自带记忆段'],
  ['autoRetry', 'bool', '推脱时自动重试'],
  ['autoContinue', 'bool', '截断时自动继续'],
  ['capabilityProtocol', 'bool', '教模型发现 skill 与 MCP'],
  ['hooksDenyBypass', 'bool', 'hooks 拒绝不绕过'],
  ['verbose', 'bool', '详细日志'],
  ['postPromptOrder', 'num', '追加段顺序'],
  ['retryMax', 'num', '重试次数上限'],
  ['continueMax', 'num', '自动继续上限'],
]

function patchText() {
  try { return fs.readFileSync(CFG_PATCH, 'utf8') } catch { return '' }
}

// 读配置当前值：profile 覆盖条目优先，回退插件自带 bundle patch 的 insert.config
// （整份 patch 里有 !!js 标签，不能整体 YAML 解析，按条目块正则读）
function blockOf(text, key) {
  const at = text.indexOf(key)
  if (at < 0) return ''
  const start = Math.max(text.lastIndexOf('\n- ', at), text.lastIndexOf('\n    - ', at), 0) + 1
  const nextTop = text.indexOf('\n- ', Math.max(at, start))
  return text.slice(start, nextTop < 0 ? text.length : nextTop)
}

function parseCfgBlock(text, key) {
  const block = blockOf(text, key)
  if (!block) return null
  const out = {}
  for (const [name, kind] of CONFIG_FIELDS) {
    const m = new RegExp('^\\s{2,}' + name + ':\\s*(.+)$', 'm').exec(block)
    if (!m) continue
    const raw = m[1].trim().replace(/^['\"]|['\"]$/g, '')
    out[name] = kind === 'bool' ? raw !== 'false' : (Number(raw) || 0)
  }
  return out
}

function readInsertConfig() {
  let bundle = null
  let profile = null
  try { bundle = parseCfgBlock(fs.readFileSync(BUNDLE_PATCH, 'utf8'), 'id: dsh-purge-merged') } catch { /* 忽略 */ }
  try { profile = parseCfgBlock(fs.readFileSync(PROFILE_PATCH, 'utf8'), 'id: dsh-purge-merged') } catch { /* 忽略 */ }
  // profile 是覆盖层：只带改过的字段，其余回落到插件自带默认
  return { ...(bundle || {}), ...(profile || {}) }
}

// 只改 profile 覆盖条目里的那一行（保留注释）；没有条目就追加一条
function writeInsertConfig(key, value) {
  let text = ''
  try { text = fs.readFileSync(PROFILE_PATCH, 'utf8') } catch { text = '' }
  const rendered = typeof value === 'boolean' ? String(value) : String(Number(value) || 0)
  const block = blockOf(text, 'id: dsh-purge-merged')

  if (block) {
    const line = new RegExp('^(\\s{2,}' + key + ':[ \\t]*)(.*)$', 'm')
    let next = block
    if (line.test(next)) {
      next = next.replace(line, (m, head) => head + rendered)
    } else if (/^\s*config:\s*$/m.test(next)) {
      next = next.replace(/^(\s*)config:\s*$/m, (m, ind) => m + '\n' + ind + '  ' + key + ': ' + rendered)
    } else {
      next = next.replace(/\s*$/, '') + '\n  config:\n    ' + key + ': ' + rendered + '\n'
    }
    text = text.replace(block, next)
  } else {
    const block2 = '\n- id: dsh-purge\n  name: dsh-purge-merged\n  config:\n    ' + key + ': ' + rendered + '\n'
    text = text.replace(/\s*$/, '') + '\n' + block2
  }

  fs.writeFileSync(PROFILE_PATCH, text, 'utf8')
  cache.at = 0
  return true
}

function countDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
  } catch { return 0 }
}

// 规则集：$DSH_HOME/rules 下的 <id>.md + state.json 的当前项
function ruleItems() {
  try {
    const dir = path.join(HOME, 'rules')
    const state = readJson(path.join(dir, 'state.json')) || {}
    const active = String(state.active || state.current || state.id || '')
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort()
      .slice(0, 8)
      .map((id) => ({
        title: id,
        trailing: id === active ? '当前' : '',
        action: { id: 'purge-rule-use', args: { id } },
      }))
  } catch { return [] }
}

// 技能：$DSH_HOME/skills 下的目录名（只读列表）
function skillItems() {
  try {
    return fs.readdirSync(path.join(HOME, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .slice(0, 8)
      .map((id) => ({ title: id }))
  } catch { return [] }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function fileExists(file) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}

function hostVersion() {
  return readJson(HOST_PKG)?.version ?? ''
}

function dshBase() {
  return path.resolve(path.dirname(HOST_PKG), '../../..')
}

function shimState() {
  let src = ''
  try {
    src = fs.readFileSync(SHIM, 'utf8')
  } catch {
    return { text: '未找到', tone: 'warn' }
  }
  return src.includes('dsh-purge shim begin')
    ? { text: 'purge 已接管', tone: 'good' }
    : { text: '原始入口', tone: 'warn' }
}

function injectState() {
  if (!fileExists(INJECT_FILE)) return { text: '缺失', tone: 'bad' }
  const override = readJson(path.join(CORE_DIR, 'override-state.json'))
  const customized = override?.customized === true
  return { text: customized ? '已注入（自定义）' : '已注入', tone: 'good' }
}

// 备份目录名有多种来源（自动快照 `2026-11-11T21-04-01-969Z-xxxx`、手动 `preset-unrestricted-20261112`），
// 面板只显示时间，不露文件名。拿不到时间就退回目录 mtime，再不行才显示原名。
function backupTime(name, dir) {
  const iso = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-?(\d{2})?/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}`
  const compact = name.match(/(?:^|[-_])(\d{4})(\d{2})(\d{2})(?:[-_]?(\d{2})(\d{2}))?$/)
  if (compact) {
    const time = compact[4] ? ` ${compact[4]}:${compact[5]}` : ''
    return `${compact[1]}-${compact[2]}-${compact[3]}${time}`
  }
  try {
    const d = fs.statSync(dir)
    const t = d.mtime
    const pad = (n) => String(n).padStart(2, '0')
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`
  } catch {
    return ''
  }
}

function backupList() {
  const root = path.join(MERGED_DIR, 'backups')
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, dir: path.join(root, e.name), at: 0 }))
  } catch {
    return []
  }
  for (const entry of entries) {
    try { entry.at = fs.statSync(entry.dir).mtimeMs } catch { entry.at = 0 }
    const iso = entry.name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/)
    if (iso) {
      const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:00`)
      if (!Number.isNaN(t)) entry.at = t
    }
  }
  entries.sort((a, b) => b.at - a.at)
  return entries.slice(0, 2).map((e) => backupTime(e.name, e.dir)).filter(Boolean)
}

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    if (!fileExists(CLI)) {
      resolve({ ok: false, error: 'missing-cli' })
      return
    }
    let out = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(process.execPath, [CLI, ...args], {
        cwd: dshBase(),
        env: {
          ...process.env,
          DSH_BASE: dshBase(),
          PURGE_DSH_CLI: path.join(dshBase(), 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, error: String(err?.message || err) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({ ok: false, error: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', (err) => finish({ ok: false, error: String(err?.message || err) }))
    child.on('close', (code) => {
      // selfcheck 在「有层没通过」时会以非 0 退出，但 stdout 仍是完整 JSON：
      // 先按 JSON 解析，解析不了才算失败。
      const parsed = parseJsonLoose(out)
      if (parsed) {
        finish({ ok: true, data: parsed, code })
        return
      }
      finish({ ok: false, error: `exit-${code}`, raw: out.slice(-400) })
    })
  })
}

function parseJsonLoose(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    try {
      return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
    } catch {
      return null
    }
  }
}

function patchSummary(patch) {
  if (!patch) return { text: '待自检', tone: 'info', caption: '点「重新自检」' }
  const applied = Number(patch.applied ?? 0)
  // 真实待办数只认 selfcheck 的 summary.pending；applied 可能超过 total-disabled，
  // 所以分母统一用「已应用 + 待应用」，避免出现 67/66 这种倒挂。
  const pending = Math.max(0, Number(cache.pending ?? 0))
  const applicable = applied + pending
  // 不适用条数直接取 selfcheck 的 not_applicable；不要用 total-applied 反推，
  // 否则会把「无需处理」的那 1 条算进不适用，和面板三个数字对不上。
  const na = Math.max(0, Number(patch.not_applicable ?? 0))
  if (pending === 0) {
    return { text: `${applied}/${applicable}`, tone: 'good', caption: na > 0 ? `另 ${na} 条不适用` : '已全部应用' }
  }
  return { text: `${applied}/${applicable}`, tone: 'warn', caption: `还有 ${pending} 条待应用` }
}

function naNote(patch) {
  if (!patch) return ''
  const parts = []
  const desktop = Number(patch.na_desktop ?? 0)
  const optionalTarget = Number(patch.na_optional_target ?? 0)
  const retired = Number(patch.na_retired ?? 0)
  const other = Number(patch.na_other ?? 0)
  if (desktop) parts.push(`桌面${desktop}条`)
  if (optionalTarget) parts.push(`未装${optionalTarget}条`)
  if (retired) parts.push(`已移除${retired}条`)
  if (other) parts.push(`其他${other}条`)
  if (!parts.length) return ''
  return `不适用 · ${parts.join(' · ')}`
}

function snapshot() {
  const update = readJson(path.join(CORE_DIR, 'update-status.json'))
  const shim = shimState()
  const inject = injectState()
  const backups = backupList()
  const p = patchSummary(cache.patch)
  // 只解析一次：以前这行把同一份 package.json 读了两次。
  const selfVersion = readJson(path.join(PKG_ROOT, 'package.json'))?.version
  const plugin = update?.installedVersion ? `v${update.installedVersion}` : selfVersion ? `v${selfVersion}` : ''

  let note = '补丁已写盘；引擎重启后新进程才会加载打补丁的代码。'
  let noteTone = 'info'
  if (update?.restartRequired === true) {
    note = '有改动待重启：重启引擎后生效。'
    noteTone = 'warn'
  } else if (cache.patch && cache.patch.total > 0 && cache.patch.applied >= cache.patch.total) {
    note = '补丁齐了。若刚应用过，重启引擎后新代码才生效。'
    noteTone = 'good'
  }

  const patchAll = Number(cache.patch?.all ?? 0)
  const patchApplied = Number(cache.patch?.applied ?? 0)
  // 不适用只认 selfcheck 的 not_applicable（明确标注 na 的条目），
  // 不要用 total-applied 反推，否则会把「无需处理」算成不适用。
  const patchNa = Math.max(0, Number(cache.patch?.not_applicable ?? Math.max(0, patchAll - patchApplied)))
  const patchSkipped = Math.max(0, patchAll - patchApplied)
  // 跳过 = 总数 − 应用 − 不适用，也就是「既没应用、也不是本机不适用」的那一条。
  const patchRest = Math.max(0, patchSkipped - patchNa)
  const rtDir = path.join(HOME, 'redteam')
  const rtState = (() => {
    try {
      return {
        config: fileExists(path.join(rtDir, 'config.json')) ? '已配置' : '未配置',
        engagements: String(countDirs(path.join(rtDir, 'engagements'))),
        knowledge: (() => {
          try { return bytesText(fs.statSync(path.join(rtDir, 'knowledge.db')).size) } catch { return '—' }
        })(),
        preset: readJson(path.join(rtDir, 'preset-declare.json')) ? '已声明' : '未声明',
      }
    } catch { return { config: '—', engagements: '—', knowledge: '—', preset: '—' } }
  })()

  const insCfg = readInsertConfig()
  const cfgFields = {}
  for (const [key, kind] of CONFIG_FIELDS) {
    cfgFields['c_' + key] = kind === 'bool' ? insCfg[key] !== false : Number(insCfg[key] ?? 0)
  }

  return {
    patchText: p.text,
    patchTone: p.tone,
    patchCaption: p.caption,
    patchAll: patchAll ? String(patchAll) : '—',
    patchApplied: cache.patch ? String(patchApplied) : '—',
    patchRest: cache.patch ? String(patchRest) : '—',
    patchNa: cache.patch ? String(patchNa) : '—',
    patchNaNote: naNote(cache.patch),
    patchAllText: cache.patch ? patchAll + ' 条' : '—',
    patchAppliedText: cache.patch ? patchApplied + ' 条' : '—',
    patchRestText: cache.patch ? patchRest + ' 条' : '—',
    patchNaText: cache.patch ? patchNa + ' 条' : '—',
    backupCount: backupCache.usage?.count !== undefined
      ? String(backupCache.usage.count)
      : (backupCache.at ? String(backupCache.list.length) : '—'),
    backupUsage: bytesText(backupCache.usage?.bytes),
    backupSelected: selectedBackup ? shortId(selectedBackup) : '未选',
    backupItems: backupCache.list.slice(0, 5).map((b) => ({
      title: shortId(b.id) || String(b.id || '').slice(0, 20),
      subtitle: String(b.reason || 'snapshot') + (Array.isArray(b.plugins) ? ` · ${b.plugins.length} 个插件` : ''),
      trailing: b.host_version ? 'v' + String(b.host_version).slice(0, 12) : '',
      action: { id: 'purge-pick', args: { id: b.id } },
    })),
    updateCurrent: update?.installedVersion ? 'v' + String(update.installedVersion).slice(0, 16) : (plugin || '—'),
    updateLatest: lastCheck?.remoteVersion
      ? String(lastCheck.remoteVersion).slice(0, 20)
      : (update?.remoteVersion ? String(update.remoteVersion).slice(0, 20) : '—'),
    updateStatus: update?.restartRequired === true
      ? '待重启'
      : (lastCheck ? '刚检查过' : (update?.status ? String(update.status).slice(0, 16) : '未检查')),
    rtConfig: rtState.config,
    rtEngagements: rtState.engagements,
    rtKnowledge: rtState.knowledge,
    rtPreset: rtState.preset,
    ruleItems: ruleItems(),
    skillItems: skillItems(),
    ...cfgFields,
    pluginVersion: plugin || '—',
    hostVersion: hostVersion() || '—',
    shim: shim.text,
    inject: inject.text,
    backupText: backups[0] || '无',
    backupPrevText: backups[1] || '无',
    note,
    noteTone,
  }
}

function summaryText() {
  const s = snapshot()
  return [
    `破甲状态：补丁 ${s.patchText}`,
    `插件 ${s.pluginVersion} · 宿主 ${s.hostVersion}`,
    `入口：${s.shim} · 注入：${s.inject}`,
    `备份：${s.backupText}${s.backupPrevText !== '无' ? ` / ${s.backupPrevText}` : ''}`,
  ].join('\n')
}

async function selfcheck() {
  if (cache.running) return null
  cache.running = true
  try {
    const result = await runCli(['selfcheck', '--json'], 45_000)
    if (result.ok) {
      cache.patch = result.data?.patch ?? null
      cache.pending = Number(result.data?.summary?.pending?.patches ?? 0)
      cache.at = Date.now()
    }
    return result
  } finally {
    cache.running = false
  }
}

export function registerDshGoPanel(ctx, deps = {}) {
  ctx.inject(['dshGo'], (ctx) => {
    // 不再占用输入框上方的状态条：入口放在加号面板（composer.tools → panel）和「插件」页签。
    ctx.dshGo.panel('purge', {
      view: () => ({
        v: 2,
        type: 'stack',
        title: '破甲状态',
        children: [
          { type: 'text', text: '宿主补丁', style: { size: 'title', weight: 'bold' } },
          {
            type: 'keyValue',
            items: [
              { label: '补丁总数', value: { $: 'data.patchAllText' }, tone: 'good' },
              { label: '已应用补丁', value: { $: 'data.patchAppliedText' }, tone: 'good' },
              { label: '已跳过补丁', value: { $: 'data.patchRestText' }, tone: 'warn' },
              { label: '不适用补丁', value: { $: 'data.patchNaText' }, tone: 'bad' },
            ],
          },
          // 不适用的构成说明单独占一整行，避免落在 metric 的窄格子里被折断。
          { type: 'text', text: { $: 'data.patchNaNote' }, tone: 'muted', style: { size: 'caption' } },
          {
            type: 'keyValue',
            items: [
              ['插件版本', { $: 'data.pluginVersion' }],
              ['宿主版本', { $: 'data.hostVersion' }],
              ['启动入口', { $: 'data.shim' }],
              ['提示词注入', { $: 'data.inject' }],
              ['最近备份', { $: 'data.backupText' }],
              ['上一次', { $: 'data.backupPrevText' }],
            ],
          },
          { type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.noteTone' } },
          {
            type: 'actions',
            items: [
              { label: '重新自检', action: 'purge-check' },
              { label: '应用补丁', action: { id: 'purge-apply', args: { confirmed: true } } },
            ],
          },

        ],
      }),
      // 面板打开期间每 5 秒推一次快照，让后台自检 / 应用补丁的结果自动出现。
      data: (scope, emit) => {
        emit(snapshot())
        if (!cache.patch || Date.now() - cache.at > CACHE_TTL) {
          selfcheck().then(() => emit(snapshot())).catch(() => {})
        }
        if (Date.now() - backupCache.at > 60_000) {
          refreshBackups().then(() => emit(snapshot())).catch(() => {})
        }
        const timer = setInterval(() => emit(snapshot()), 5000)
        return () => clearInterval(timer)
      },
      actions: {
        'purge-check': () => {
          selfcheck().catch(() => {})
          return { toast: '正在自检，几秒后看面板' }
        },
        'purge-copy': () => ({ copy: summaryText(), toast: '摘要已复制' }),

        'purge-apply': (scope, event) => {
          const confirmed = event?.value?.confirmed === true || event?.args?.confirmed === true
          if (!confirmed) return { toast: '已取消' }
          runCli(['apply'], 60_000)
            .then((result) => { cache.at = 0; return selfcheck().then(() => result) })
            .catch(() => {})
          return { toast: '正在应用补丁，几秒后看面板' }
        },
        'purge-revert': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: '已取消' }
          runCli(['revert'], 90_000)
            .then(() => { cache.at = 0; backupCache.at = 0; return selfcheck() })
            .catch(() => {})
          return { toast: '正在还原补丁，几秒后看面板' }
        },
        'purge-uninstall': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: '已取消' }
          runCli(['uninstall'], 90_000)
            .then(() => { cache.at = 0; backupCache.at = 0; return selfcheck() })
            .catch(() => {})
          return { toast: '正在卸载破甲，完成后重启引擎' }
        },

        'purge-backup': () => {
          runCli(['backup'], 120_000)
            .then(() => { backupCache.at = 0; return refreshBackups() })
            .catch(() => {})
          return { toast: '正在新建备份' }
        },
        'purge-pick': (scope, event) => {
          const id = String(event?.value?.id ?? event?.args?.id ?? '')
          if (!id) return { toast: '没拿到备份 ID' }
          selectedBackup = id
          return { toast: '已选中：' + shortId(id), patch: snapshot() }
        },
        'purge-rollback': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: '已取消' }
          if (!selectedBackup) return { toast: '先点一份备份选中' }
          const id = selectedBackup
          runCli(['rollback', id], 180_000)
            .then(() => { cache.at = 0; backupCache.at = 0; return selfcheck() })
            .catch(() => {})
          return { toast: '正在回滚：' + shortId(id) }
        },
        'purge-prune': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: '已取消' }
          runCli(['prune'], 120_000)
            .then(() => { backupCache.at = 0; return refreshBackups() })
            .catch(() => {})
          return { toast: '正在清理旧备份' }
        },

        'purge-update': (scope, event) => {
          if (event?.value?.confirmed !== true) return { toast: '已取消' }
          const updates = deps.updates
          if (!updates) return { toast: '更新通道不可用' }
          return {
            pending: { label: '正在更新', timeoutMs: 60_000 },
            result: async () => {
              try {
                const result = lastCheck || await updates.check()
                const applied = await updates.install(result)
                cache.at = 0
                return { toast: applied?.applied === false ? '这条通道不自动装' : '更新已应用，重启引擎生效', refresh: true }
              } catch (err) {
                return { toast: '更新失败：' + String(err?.message || err).slice(0, 24) }
              }
            },
          }
        },
        'purge-update-check': () => {
          const updates = deps.updates
          if (!updates) return { toast: '更新通道不可用' }
          return {
            pending: { label: '正在检查更新', timeoutMs: 45_000 },
            result: async () => {
              try {
                lastCheck = await updates.check()
                backupCache.at = 0
                const v = lastCheck?.remoteVersion || lastCheck?.lanes?.stable?.latestRef
                return { toast: v ? '最新可用：' + String(v).slice(0, 20) : '已是最新', refresh: true }
              } catch (err) {
                return { toast: '检查失败：' + String(err?.message || err).slice(0, 24) }
              }
            },
          }
        },

        // 改一项配置就写回 patch（onChange 触发，不等表单提交）
        'purge-config': (scope, event) => {
          const key = String(event?.args?.key || '')
          if (!key) return { toast: '没拿到字段名' }
          const raw = event?.value
          const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw
          try {
            writeInsertConfig(key, value)
          } catch (err) {
            return { toast: '写入失败：' + String(err?.message || err).slice(0, 16) }
          }
          return { toast: key + ' 已写入，重启生效', patch: snapshot() }
        },

        'purge-rule-use': (scope, event) => {
          const id = String(event?.value?.id ?? event?.args?.id ?? '')
          if (!id) return { toast: '没拿到规则 ID' }
          return { command: 'rules use ' + id }
        },
        'purge-rules-all': () => ({ command: 'rules list' }),
        'purge-skills-all': () => ({ command: 'skills list' }),
      },
    })
  })
}
