import type { AppState } from '../state/types.js'
import { getTheme, toggleTheme } from '../theme.js'
import { useState } from 'react'
import { DirPicker } from './DirPicker.js'
import type { DirPickerHandle } from './DirPicker.js'

function fmt(n: number | undefined): string {
  if (n === null || n === undefined) return '—'
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

export function Header({ state, onMenu, onOpenManage, onChangeCwd, dirPickerRef }: { state: AppState; onMenu: () => void; onOpenManage: () => void; onChangeCwd: (cwd: string) => void; dirPickerRef?: React.Ref<DirPickerHandle> }) {
  const [, force] = useState(0)
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
        {state.model ? <span className="chip">模型 {state.model}</span> : null}
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
