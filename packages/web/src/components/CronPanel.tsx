import { useCallback, useEffect, useState } from 'react'
import type { CronTaskWithNext, CronTaskInput, CronRun, CronRunDetail, CronRunStatus, CronPermissionMode } from '@zuse/protocol'
import { listCronTasks, createCronTask, updateCronTask, deleteCronTask, listCronRuns, runCronNow, getCronRunDetail } from '../state/cronApi.js'
import { projectSnapshotMessages } from '../state/reducer.js'
import { MessageList } from './MessageList.js'

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：调度预设 ↔ cron 表达式（务必与后端 5 段语义一致）
// ─────────────────────────────────────────────────────────────────────────────

/** 调度预设。HH:MM 拆成 M H；monthly 用 day-of-month。 */
export type CronPreset =
  | { kind: 'hourly' }
  | { kind: 'daily'; h: number; m: number }
  | { kind: 'weekly'; dow: number; h: number; m: number }
  | { kind: 'monthly'; dom: number; h: number; m: number }
  | { kind: 'custom'; expr: string }

/** 预设 → cron 表达式。 */
export function presetToCron(p: CronPreset): string {
  switch (p.kind) {
    case 'hourly': return '0 * * * *'
    case 'daily': return `${p.m} ${p.h} * * *`
    case 'weekly': return `${p.m} ${p.h} * * ${p.dow}`
    case 'monthly': return `${p.m} ${p.h} ${p.dom} * *`   // day-of-month（用户点名要）
    case 'custom': return p.expr
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const isNum = (s: string): boolean => /^\d+$/.test(s)

/** cron 表达式 → 预设形状（反显 / 编辑时回填下拉；无法匹配 → custom）。 */
export function cronToPreset(expr: string): CronPreset {
  const parts = expr.trim().split(/\s+/)
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
    if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return { kind: 'hourly' }
    if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && dow === '*') return { kind: 'daily', h: +hour, m: +min }
    if (isNum(min) && isNum(hour) && dom === '*' && mon === '*' && isNum(dow)) return { kind: 'weekly', dow: +dow % 7, h: +hour, m: +min }
    if (isNum(min) && isNum(hour) && isNum(dom) && mon === '*' && dow === '*') return { kind: 'monthly', dom: +dom, h: +hour, m: +min }
  }
  return { kind: 'custom', expr }
}

/** 五种预设形状的人读描述（中文）；无法匹配则原样返回表达式。 */
export function describeCron(expr: string): string {
  const p = cronToPreset(expr)
  switch (p.kind) {
    case 'hourly': return '每小时'
    case 'daily': return `每天 ${pad(p.h)}:${pad(p.m)}`
    case 'weekly': return `每${WEEKDAYS[p.dow] ?? ''} ${pad(p.h)}:${pad(p.m)}`
    case 'monthly': return `每月 ${p.dom} 号 ${pad(p.h)}:${pad(p.m)}`
    case 'custom': return p.expr
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const truncate = (s: string, n = 40): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** ISO → 本地日期时间（不可解析则原样返回）。 */
function fmtTime(iso: string): string {
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString()
}

/** 下次执行的相对时间（null → 未排期）。 */
function relTime(iso: string | null): string {
  if (!iso) return '未排期'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = t - Date.now()
  if (diff <= 0) return '即将'
  const min = Math.round(diff / 60000)
  if (min < 60) return `${min} 分钟后`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} 小时后`
  return `${Math.round(h / 24)} 天后`
}

const PERM_OPTS: { value: CronPermissionMode; label: string }[] = [
  { value: 'bypass', label: '全自主 · 跳过所有确认 (bypass)' },
  { value: 'acceptEdits', label: '自动接受编辑 (acceptEdits)' },
  { value: 'default', label: '默认档 (default)' },
]

function RunStatusIcon({ status }: { status: CronRunStatus }) {
  if (status === 'running') return <span className="cron-status running" title="执行中" aria-label="执行中">⟳</span>
  if (status === 'success') return <span className="cron-status success" title="成功" aria-label="成功">✓</span>
  return <span className="cron-status failed" title="失败" aria-label="失败">✕</span>
}

// ─────────────────────────────────────────────────────────────────────────────
// 建/改任务表单
// ─────────────────────────────────────────────────────────────────────────────

function CronTaskForm({ initial, onSaved, onCancel }: {
  initial?: CronTaskWithNext
  onSaved: () => void
  onCancel: () => void
}) {
  const p0 = initial ? cronToPreset(initial.cron) : ({ kind: 'daily', h: 9, m: 0 } as CronPreset)
  const [name, setName] = useState(initial?.name ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [cwd, setCwd] = useState(initial?.cwd ?? '')
  const [permissionMode, setPermissionMode] = useState<CronPermissionMode>(initial?.permissionMode ?? 'bypass')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [schedKind, setSchedKind] = useState<CronPreset['kind']>(p0.kind)
  const hasTime = p0.kind === 'daily' || p0.kind === 'weekly' || p0.kind === 'monthly'
  const [h, setH] = useState(hasTime ? p0.h : 9)
  const [m, setM] = useState(hasTime ? p0.m : 0)
  const [dow, setDow] = useState(p0.kind === 'weekly' ? p0.dow : 1)
  const [dom, setDom] = useState(p0.kind === 'monthly' ? p0.dom : 1)
  const [customExpr, setCustomExpr] = useState(p0.kind === 'custom' ? p0.expr : (initial?.cron ?? '0 9 * * *'))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const buildCron = (): string => {
    switch (schedKind) {
      case 'hourly': return presetToCron({ kind: 'hourly' })
      case 'daily': return presetToCron({ kind: 'daily', h, m })
      case 'weekly': return presetToCron({ kind: 'weekly', dow, h, m })
      case 'monthly': return presetToCron({ kind: 'monthly', dom, h, m })
      case 'custom': return customExpr.trim()
    }
  }

  const valid = name.trim() !== '' && prompt.trim() !== '' && buildCron() !== ''

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    const body: CronTaskInput = {
      name: name.trim(), prompt: prompt.trim(), cron: buildCron(),
      cwd: cwd.trim() || undefined, permissionMode, enabled,
    }
    const p = initial ? updateCronTask(initial.id, body) : createCronTask(body)
    Promise.resolve(p)
      .then(() => onSaved())
      .catch((err: unknown) => { setError(msgOf(err)); setSaving(false) })
  }

  const timeValue = `${pad(h)}:${pad(m)}`
  const onTimeChange = (v: string): void => {
    const [hh, mm] = v.split(':')
    if (hh !== undefined) setH(Math.min(23, Math.max(0, Number(hh) || 0)))
    if (mm !== undefined) setM(Math.min(59, Math.max(0, Number(mm) || 0)))
  }

  return (
    <form className="mem-form" onSubmit={submit}>
      <label className="mem-field">
        <span className="mem-field-label">名称</span>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 每日站会汇总" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">执行内容 (prompt)</span>
        <textarea className="cron-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="到点后交给一个全新会话执行的指令" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">调度</span>
        <select value={schedKind} onChange={(e) => setSchedKind(e.target.value as CronPreset['kind'])}>
          <option value="hourly">每小时</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
          <option value="custom">自定义 cron</option>
        </select>
      </label>
      {schedKind === 'weekly' ? (
        <label className="mem-field">
          <span className="mem-field-label">星期</span>
          <select value={dow} onChange={(e) => setDow(Number(e.target.value))}>
            {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}
          </select>
        </label>
      ) : null}
      {schedKind === 'monthly' ? (
        <label className="mem-field">
          <span className="mem-field-label">日 (1–31)</span>
          <input type="number" min={1} max={31} value={dom} onChange={(e) => setDom(Math.min(31, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
      ) : null}
      {schedKind === 'daily' || schedKind === 'weekly' || schedKind === 'monthly' ? (
        <label className="mem-field">
          <span className="mem-field-label">时间</span>
          <input type="time" value={timeValue} onChange={(e) => onTimeChange(e.target.value)} />
        </label>
      ) : null}
      {schedKind === 'custom' ? (
        <label className="mem-field">
          <span className="mem-field-label">cron 表达式 <span className="mem-opt">(5 段)</span></span>
          <input type="text" value={customExpr} onChange={(e) => setCustomExpr(e.target.value)} placeholder="0 9 * * *" />
        </label>
      ) : null}
      <div className="cron-preview">规则：{describeCron(buildCron())} <span className="mem-opt">({buildCron() || '—'})</span></div>
      <label className="mem-field">
        <span className="mem-field-label">工作目录 <span className="mem-opt">(留空 = daemon 默认目录)</span></span>
        <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
      </label>
      <label className="mem-field">
        <span className="mem-field-label">权限档位</span>
        <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as CronPermissionMode)}>
          {PERM_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {permissionMode === 'bypass' ? (
        <div className="cron-warn">⚠ 无人看管会话将跳过所有权限确认、全自动执行（全局 deny 表仍是硬底线）。</div>
      ) : null}
      <label className="cron-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>启用（到点自动执行）</span>
      </label>
      {error ? <div className="mem-error">{error}</div> : null}
      <div className="mem-form-actions">
        <button type="submit" disabled={!valid || saving}>{initial ? '保存' : '新建'}</button>
        <button type="button" className="ghost" onClick={onCancel}>取消</button>
      </div>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 任务列表
// ─────────────────────────────────────────────────────────────────────────────

function CronTaskRow({ task, onOpen, onEdit, onChanged }: {
  task: CronTaskWithNext
  onOpen: (task: CronTaskWithNext) => void
  onEdit: (task: CronTaskWithNext) => void
  onChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = (p: Promise<unknown> | unknown): void => {
    setBusy(true)
    Promise.resolve(p).then(onChanged).catch(() => { /* best-effort; list refetch shows truth */ }).finally(() => setBusy(false))
  }
  return (
    <li className="mem-item cron-item">
      <button type="button" className="cron-open" onClick={() => onOpen(task)} title="查看执行记录">
        <span className="cron-run-label">
          <span className="mem-label">{task.name}</span>
          <span className="cron-meta">{describeCron(task.cron)} · 下次 {relTime(task.nextRun)}</span>
        </span>
      </button>
      {confirming ? (
        <span className="mem-confirm">
          <button className="mem-confirm-yes" title="确认删除" aria-label="确认删除" onClick={() => { setConfirming(false); act(deleteCronTask(task.id)) }}>✓</button>
          <button className="mem-confirm-no" title="取消" aria-label="取消删除" onClick={() => setConfirming(false)}>✕</button>
        </span>
      ) : (
        <span className="mem-actions">
          <label className="cron-toggle" title={task.enabled ? '已启用（点击停用）' : '已停用（点击启用）'}>
            <input type="checkbox" checked={task.enabled} disabled={busy} aria-label="启用/停用" onChange={() => act(updateCronTask(task.id, { enabled: !task.enabled }))} />
          </label>
          <button className="mem-edit" title="立即执行" aria-label="立即执行" disabled={busy} onClick={() => act(runCronNow(task.id))}>▶</button>
          <button className="mem-edit" title="编辑" aria-label="编辑" onClick={() => onEdit(task)}>✎</button>
          <button className="mem-del" title="删除" aria-label="删除任务" onClick={() => setConfirming(true)}>×</button>
        </span>
      )}
    </li>
  )
}

function CronTasksView({ onOpen }: { onOpen: (task: CronTaskWithNext) => void }) {
  const [tasks, setTasks] = useState<CronTaskWithNext[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const reload = useCallback(() => {
    listCronTasks()
      .then((t) => { setTasks(Array.isArray(t) ? t : []); setError(null) })
      .catch((e: unknown) => setError(msgOf(e)))
  }, [])
  useEffect(() => { reload() }, [reload])

  return (
    <div className="cron-tasks">
      <div className="mem-toolbar">
        <div className="persona-hint">到点自动开一个全新会话执行你配置的内容，并留档历次执行结果。</div>
        <button className="mem-new" onClick={() => { setEditing(null); setCreating((c) => !c) }}>＋ 新建</button>
      </div>
      {creating ? <CronTaskForm onSaved={() => { setCreating(false); reload() }} onCancel={() => setCreating(false)} /> : null}
      {error ? <div className="mem-error">{error}</div> : null}
      {tasks === null ? <div className="mem-empty">加载中…</div>
        : tasks.length === 0 && !creating ? <div className="mem-empty">还没有定时任务</div>
        : (
          <ul className="mem-list">
            {tasks.map((t) => editing === t.id
              ? <li key={t.id} className="mem-item-editing"><CronTaskForm initial={t} onSaved={() => { setEditing(null); reload() }} onCancel={() => setEditing(null)} /></li>
              : <CronTaskRow key={t.id} task={t} onOpen={onOpen} onEdit={(task) => { setCreating(false); setEditing(task.id) }} onChanged={reload} />)}
          </ul>
        )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 执行记录列表
// ─────────────────────────────────────────────────────────────────────────────

function CronRunsView({ task, onBack, onOpen }: {
  task: CronTaskWithNext
  onBack: () => void
  onOpen: (runId: string) => void
}) {
  const [runs, setRuns] = useState<CronRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    listCronRuns(task.id)
      .then((r) => { setRuns(Array.isArray(r) ? r : []); setError(null) })
      .catch((e: unknown) => setError(msgOf(e)))
  }, [task.id])
  return (
    <>
      <div className="cron-subhead">
        <button className="cron-back" onClick={onBack}>← 返回</button>
        <span className="cron-subtitle">{task.name} · 执行记录</span>
      </div>
      <div className="cron-scroll">
        {error ? <div className="mem-error">{error}</div> : null}
        {runs === null ? <div className="mem-empty">加载中…</div>
          : runs.length === 0 ? <div className="mem-empty">还没有执行记录</div>
          : (
            <ul className="mem-list">
              {runs.map((r) => (
                <li key={r.id} className="mem-item cron-item">
                  <button type="button" className="cron-open" onClick={() => onOpen(r.id)} title="查看本次对话">
                    <RunStatusIcon status={r.status} />
                    <span className="cron-run-label">
                      <span className="mem-label">{truncate(task.prompt)}</span>
                      <span className="cron-meta">{r.summary ? truncate(r.summary, 60) : r.error ? truncate(r.error, 60) : r.status} · {fmtTime(r.startedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 单次执行详情（复用聊天流的 <MessageList> 渲染 SnapshotMessage[]）
// ─────────────────────────────────────────────────────────────────────────────

function CronRunDetail({ task, runId, onBack }: {
  task: CronTaskWithNext
  runId: string
  onBack: () => void
}) {
  const [detail, setDetail] = useState<CronRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    getCronRunDetail(task.id, runId)
      .then((d) => { setDetail(d); setError(null) })
      .catch((e: unknown) => setError(msgOf(e)))
  }, [task.id, runId])
  const messages = detail ? projectSnapshotMessages(detail.messages) : []
  return (
    <>
      <div className="cron-subhead">
        <button className="cron-back" onClick={onBack}>← 返回</button>
        <span className="cron-subtitle">{task.name} · 执行详情</span>
      </div>
      {error ? <div className="cron-scroll"><div className="mem-error">{error}</div></div> : null}
      {detail ? (
        <>
          <div className="cron-detail-head">
            <RunStatusIcon status={detail.run.status} />
            <span className="cron-meta">{fmtTime(detail.run.startedAt)}{detail.run.finishedAt ? ` → ${fmtTime(detail.run.finishedAt)}` : ''}</span>
          </div>
          {detail.run.error ? <div className="cron-detail-head"><div className="mem-error">{detail.run.error}</div></div> : null}
          {messages.length ? <MessageList messages={messages} thinking={false} /> : <div className="cron-scroll"><div className="mem-empty">（本次执行没有可显示的消息）</div></div>}
        </>
      ) : (!error ? <div className="cron-scroll"><div className="mem-empty">加载中…</div></div> : null)}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 面板容器：list | runs(task) | detail(task, runId)
// ─────────────────────────────────────────────────────────────────────────────

type CronView =
  | { kind: 'list' }
  | { kind: 'runs'; task: CronTaskWithNext }
  | { kind: 'detail'; task: CronTaskWithNext; runId: string }

export function CronPanel() {
  const [view, setView] = useState<CronView>({ kind: 'list' })
  return (
    <div className="cron-panel">
      {view.kind === 'list' ? (
        <div className="cron-scroll"><CronTasksView onOpen={(task) => setView({ kind: 'runs', task })} /></div>
      ) : view.kind === 'runs' ? (
        <CronRunsView task={view.task} onBack={() => setView({ kind: 'list' })} onOpen={(runId) => setView({ kind: 'detail', task: view.task, runId })} />
      ) : (
        <CronRunDetail task={view.task} runId={view.runId} onBack={() => setView({ kind: 'runs', task: view.task })} />
      )}
    </div>
  )
}
