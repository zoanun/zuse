import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'

const legacy = (m: Parameters<typeof StreamLanguage.define>[0]): Extension => StreamLanguage.define(m)

/** Extension (or filename) → CodeMirror language extensions. Empty = plain text (still editable). */
const BY_EXT: Record<string, () => Extension[]> = {
  js: () => [javascript()], jsx: () => [javascript({ jsx: true })],
  ts: () => [javascript({ typescript: true })], tsx: () => [javascript({ typescript: true, jsx: true })],
  mjs: () => [javascript()], cjs: () => [javascript()],
  json: () => [json()], jsonc: () => [json()],
  css: () => [css()], scss: () => [css()], less: () => [css()],
  html: () => [html()], htm: () => [html()], vue: () => [html()],
  md: () => [markdown()], markdown: () => [markdown()],
  py: () => [python()], java: () => [java()],
  c: () => [cpp()], h: () => [cpp()], cc: () => [cpp()], cpp: () => [cpp()], hpp: () => [cpp()], cxx: () => [cpp()],
  rs: () => [rust()], go: () => [go()],
  php: () => [php()], sql: () => [sql()],
  xml: () => [xml()], svg: () => [xml()],
  yaml: () => [yaml()], yml: () => [yaml()],
  sh: () => [legacy(shell)], bash: () => [legacy(shell)], zsh: () => [legacy(shell)],
  bat: () => [legacy(shell)], cmd: () => [legacy(shell)],
  properties: () => [legacy(properties)], ini: () => [legacy(properties)], env: () => [legacy(properties)], conf: () => [legacy(properties)],
  toml: () => [legacy(toml)],
  rb: () => [legacy(ruby)], lua: () => [legacy(lua)],
  ps1: () => [legacy(powerShell)], psm1: () => [legacy(powerShell)],
}
// Filenames (no extension) with a known language.
const BY_NAME: Record<string, () => Extension[]> = {
  dockerfile: () => [legacy(dockerFile)],
}

function parts(path: string): { name: string; ext: string } {
  const name = (path.split(/[\\/]/).pop() ?? path)
  const dot = name.lastIndexOf('.')
  return { name: name.toLowerCase(), ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }
}

export function langExtensions(path: string): Extension[] {
  const { name, ext } = parts(path)
  if (BY_NAME[name]) return BY_NAME[name]!()
  if (BY_EXT[ext]) return BY_EXT[ext]!()
  return []
}
