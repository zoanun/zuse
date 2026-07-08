import { useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { langExtensions } from './fileLang.js'
import { useTheme } from '../theme.js'

/**
 * Thin CodeMirror wrapper: controlled value, language picked from the path, Ctrl/Cmd+S → onSave.
 * The only place CodeMirror is imported — swapping it out (e.g. back to a textarea) touches just here.
 */
export function CodeEditor({ path, value, onChange, onSave }: {
  path: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
}) {
  const theme = useTheme() // reactive: the toggle lives in Header, which doesn't re-render us
  const extensions = useMemo(() => [
    // High precedence so Mod-s beats any default binding; preventDefault stops the browser Save dialog.
    Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true }, preventDefault: true }])),
    ...langExtensions(path),
  ], [path, onSave])
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
