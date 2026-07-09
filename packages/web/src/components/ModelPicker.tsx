import { useEffect, useState } from 'react'
import { listModels, type ModelOption } from '../state/manageApi.js'

/**
 * Model switcher popover (parity with TUI /model). Loads the configured {providerId, model}
 * options on mount, renders them grouped by provider, and highlights the currently active model.
 * Picking a row switches this session immediately; the "永久保存到配置" checkbox also persists the
 * choice to project settings (mirrors TUI --save). `current` is the active model string for the highlight.
 */
/** Eye glyph marking a vision-capable model (only machine-readable capability today). */
function VisionIcon() {
  return (
    <svg className="model-cap" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="支持视觉/图片">
      <title>支持视觉/图片</title>
      <path d="M1.5 12s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function ModelPicker({ current, currentProviderId, onPick, onClose }: {
  current: string
  currentProviderId?: string
  onPick: (providerId: string, model: string, persist: boolean) => void
  onClose: () => void
}) {
  const [options, setOptions] = useState<ModelOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [persist, setPersist] = useState(false)

  useEffect(() => {
    let cancelled = false
    listModels()
      .then((r) => { if (!cancelled) setOptions(r.options) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [])

  const pick = (o: ModelOption) => { onPick(o.providerId, o.model, persist); onClose() }

  // Group consecutive options by providerId (the endpoint expands them provider-by-provider).
  let lastProvider: string | undefined
  return (
    <div className="model-pop" role="dialog" aria-label="切换模型">
      <div className="model-pop-head">切换模型</div>
      {error ? <div className="mem-error">{error}</div> : null}
      {!options && !error ? <div className="mem-empty">加载中…</div> : null}
      {options && options.length === 0 ? <div className="mem-empty">(未配置任何模型)</div> : null}
      {options && options.length > 0 ? (
        <ul className="model-list">
          {options.map((o, i) => {
            const header = o.providerId !== lastProvider ? (lastProvider = o.providerId, o.providerId) : null
            // Match by provider+model when the active provider is known, so two same-named models
            // under different providers don't both light up; fall back to name-only if it's absent.
            const isCurrent = o.model === current && (currentProviderId == null || o.providerId === currentProviderId)
            return (
              <li key={o.providerId + '/' + o.model + '#' + i}>
                {header ? <div className="model-group">{header}</div> : null}
                <button
                  type="button"
                  className={'model-row' + (isCurrent ? ' current' : '')}
                  onClick={() => pick(o)}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <span className="model-name">{o.model}</span>
                  <span className="model-meta">
                    {isCurrent ? <span className="model-badge">当前</span> : null}
                    {o.vision ? <VisionIcon /> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <label className="model-persist">
        <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
        永久保存到配置
      </label>
    </div>
  )
}
