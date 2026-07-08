import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec, EditorState } from '@codemirror/state'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { langExtensions } from './fileLang.js'
import { useTheme } from '../theme.js'

// Chinese labels for the built-in search panel (Ctrl/Cmd+F). CodeMirror looks translations up
// by the English source string via the phrases facet.
const SEARCH_PHRASES: Record<string, string> = {
  'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个',
  'all': '全部', 'match case': '区分大小写', 'by word': '全词匹配', 'regexp': '正则',
  'replace': '替换', 'replace all': '全部替换', 'close': '关闭',
  'current match': '当前匹配', 'replaced $ matches': '已替换 $ 处', 'replaced match on line $': '已替换第 $ 行的匹配',
  'on line': '于行',
}

/**
 * Thin CodeMirror wrapper: controlled value, language picked from the path, Ctrl/Cmd+S → onSave,
 * Ctrl/Cmd+F → in-editor search panel (localized). The only place CodeMirror is imported —
 * swapping it out (e.g. back to a textarea) touches just here.
 */
export function CodeEditor({ path, value, onChange, onSave }: {
  path: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
}) {
  const theme = useTheme() // reactive: the toggle lives in Header, which doesn't re-render us
  // The keymap reads onSave through a ref: parents pass inline closures whose identity changes
  // every keystroke, and putting that in the memo deps would rebuild the extensions (and make
  // CodeMirror fully reconfigure + re-parse) on every keypress.
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const extensions = useMemo(() => [
    // High precedence so Mod-s beats any default binding; preventDefault stops the browser Save dialog.
    Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { onSaveRef.current(); return true }, preventDefault: true }])),
    // In-editor find/replace: Mod-f opens the panel (pinned above the content), F3/Shift-F3 step.
    search({ top: true }),
    keymap.of(searchKeymap),
    highlightSelectionMatches(),
    EditorState.phrases.of(SEARCH_PHRASES),
    ...langExtensions(path),
  ], [path])
  return (
    <CodeMirror
      className="code-editor"
      value={value}
      theme={theme}
      extensions={extensions}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: false }}
    />
  )
}
