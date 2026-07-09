import type { AppState } from '../state/types.js'
import { getTheme, toggleTheme } from '../theme.js'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DirPicker } from './DirPicker.js'
import type { DirPickerHandle } from './DirPicker.js'
import { ModelPicker } from './ModelPicker.js'

function fmt(n: number | undefined): string {
  if (n === null || n === undefined) return '—'
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export function Header({ state, onMenu, onOpenManage, onChangeCwd, onSwitchModel, dirPickerRef }: { state: AppState; onMenu: () => void; onOpenManage: () => void; onChangeCwd: (cwd: string) => void; onSwitchModel: (providerId: string, model: string, persist: boolean) => void; dirPickerRef?: React.Ref<DirPickerHandle> }) {
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
        {ctxText ? <span className="chip">{ctxText}{tok ? ' · ' + tok : ''}</span> : null}
        <span className={'chip ' + (conn === 'live' ? 'live' : conn === 'connecting' ? 'warn' : 'down')}>
          <span className="dot" />{conn === 'live' ? '已连接' : conn === 'connecting' ? '连接中' : '离线'}
        </span>
      </div>
      <div className="mh-right">
        <button className="icon-btn" aria-label="管理" title="管理" onClick={onOpenManage}>⚙</button>
        <button className="icon-btn" aria-label="切换主题" onClick={() => { toggleTheme(); force((n) => n + 1) }}>
          {getTheme() === 'light' ? '☾' : '☀'}
        </button>
      </div>
    </div>
  )
}
