import type { AppState } from '../state/types.js'
import { getTheme, toggleTheme } from '../theme.js'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DirPicker } from './DirPicker.js'
import type { DirPickerHandle } from './DirPicker.js'
import { ModelPicker } from './ModelPicker.js'
import { modeInfo, nextMode } from './permissionMode.js'

function fmt(n: number | undefined): string {
  if (n === null || n === undefined) return '—'
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export function Header({ state, onMenu, onOpenManage, onChangeCwd, onSwitchModel, onCyclePermissionMode, cleanView, onToggleCleanView, dirPickerRef }: { state: AppState; onMenu: () => void; onOpenManage: () => void; onChangeCwd: (cwd: string) => void; onSwitchModel: (providerId: string, model: string, persist: boolean) => void; onCyclePermissionMode: (mode: import('@zuse/protocol').PermissionMode) => void; cleanView: boolean; onToggleCleanView: () => void; dirPickerRef?: React.Ref<DirPickerHandle> }) {
  const [, force] = useState(0)
  // Model picker popover: anchored under the model chip, portaled so it escapes the header's overflow.
  const [modelOpen, setModelOpen] = useState(false)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const [modelPos, setModelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const openModelPicker = () => {
    setModelOpen((o) => {
      // Only measure the anchor on the closed→open transition; the closing click needn't recompute.
      if (!o) {
        const r = modelBtnRef.current?.getBoundingClientRect()
        if (r) setModelPos({ top: r.bottom + 4, left: r.left })
      }
      return !o
    })
  }
  const ctx = state.contextTokens
  const win = state.contextWindow
  let ctxText = ''
  if (ctx !== undefined) {
    ctxText = 'ctx ' + fmt(ctx)
    if (win) ctxText += ' / ' + fmt(win) + ' · ' + Math.round((ctx / win) * 100) + '%'
  }
  const tok = state.totalUsage ? 'tok ' + fmt((state.totalUsage.input_tokens || 0) + (state.totalUsage.output_tokens || 0)) : ''
  const conn = state.connection
  return (
    <div className="main-header">
      <div className="mh-left">
        <button className="icon-btn menu-btn" aria-label="打开侧边栏" onClick={onMenu}>☰</button>
        <div className="brand mh-brand"><span className="mark">Z</span> zuse</div>
        <DirPicker ref={dirPickerRef} cwd={state.cwd ?? ''} onChange={onChangeCwd} />
        {state.model ? (
          <button ref={modelBtnRef} className="chip chip-btn" title="切换模型" onClick={openModelPicker}>模型 {state.model} ▾</button>
        ) : null}
        {modelOpen ? createPortal(
          <>
            <div className="dirpick-backdrop" onClick={() => setModelOpen(false)} />
            <div className="model-pop-anchor" style={{ top: modelPos.top, left: modelPos.left }}>
              <ModelPicker
                current={state.model ?? ''}
                currentProviderId={state.modelProviderId}
                onPick={(p, m) => onSwitchModel(p, m, false)}
                onPersist={(p, m) => onSwitchModel(p, m, true)}
                onClose={() => setModelOpen(false)}
              />
            </div>
          </>,
          document.body,
        ) : null}
        {/*
          权限档 chip。**只在 permissionModeEditable 时渲染** —— 非交互会话（cron 跑出来的、
          被网页接管的那种）切了不生效，画一个点了没反应的开关比不画更糟。
          点击 = 循环切换；另有 /mode 斜杠命令。刻意**不给全局快捷键**：只在 composer 聚焦时
          才生效的全局热键，是一个你会误触、又会在真需要时按不出来的热键；且 Composer 已绑裸 Tab。
          全自主用告警色（chip-danger），并另有常驻横幅 —— chip 本身不承担告知风险的职责。
        */}
        {state.permissionModeEditable ? (
          <button
            className={'chip chip-btn' + (state.permissionMode === 'bypass' ? ' chip-danger' : '')}
            title={modeInfo(state.permissionMode).desc + '（点击切换到「' + modeInfo(nextMode(state.permissionMode)).label + '」）'}
            onClick={() => onCyclePermissionMode(nextMode(state.permissionMode))}
          >权限 {modeInfo(state.permissionMode).label} ▾</button>
        ) : null}
        {ctxText ? <span className="chip">{ctxText}{tok ? ' · ' + tok : ''}</span> : null}
        <span className={'chip ' + (conn === 'live' ? 'live' : conn === 'connecting' ? 'warn' : 'down')}>
          <span className="dot" />{conn === 'live' ? '已连接' : conn === 'connecting' ? '连接中' : '离线'}
        </span>
      </div>
      <div className="mh-right">
        <button
          className={'icon-btn' + (cleanView ? ' on' : '')}
          aria-label="精简视图"
          aria-pressed={cleanView}
          title={cleanView ? '精简视图：只显示提问与最终回答（点击显示全部过程）' : '完整视图：显示工具调用与中间过程（点击精简）'}
          onClick={onToggleCleanView}
        >{cleanView ? '◧' : '▤'}</button>
        <button className="icon-btn" aria-label="管理" title="管理" onClick={onOpenManage}>⚙</button>
        <button className="icon-btn" aria-label="切换主题" onClick={() => { toggleTheme(); force((n) => n + 1) }}>
          {getTheme() === 'light' ? '☾' : '☀'}
        </button>
      </div>
    </div>
  )
}
