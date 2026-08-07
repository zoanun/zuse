/**
 * 进程层 —— Windows OEM 代码页重解码。
 *
 * 从 `bash.ts` 原样抽出（纯提取重构，探测逻辑与触发条件一字未改），见设计 §1。
 */

import { execSync } from 'node:child_process'

/**
 * Windows only: the TextDecoder label for the system OEM codepage, detected once. Native console
 * apps (ping, dir, systeminfo, …) write their output in the OEM codepage (e.g. 936/GBK on a zh-CN
 * machine) even when their stdout is a pipe — NOT UTF-8. Decoding those bytes as UTF-8 yields
 * mojibake, so we use this to re-decode output that UTF-8 decoding corrupted (see
 * redecodeOemIfMojibake). null = not Windows / unknown codepage / a codepage TextDecoder can't
 * handle → keep UTF-8 unchanged. Override with ZUSE_OEM_ENCODING (a WHATWG label like 'gbk').
 */
function detectWindowsOemLabel(): string | null {
  if (process.platform !== 'win32') return null
  const override = process.env.ZUSE_OEM_ENCODING
  if (override) { try { new TextDecoder(override); return override } catch { return null } }
  let cp: number | undefined
  try {
    // The OEM codepage governs piped native-console output; read it from the registry (reliable even
    // with no console attached, unlike `chcp`). Best-effort — any failure just keeps UTF-8.
    const out = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage" /v OEMCP', {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = out.match(/OEMCP\s+REG_SZ\s+(\d+)/i)
    if (m) cp = Number(m[1])
  } catch { /* detection is best-effort */ }
  const label = cp === undefined ? undefined : ({
    936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866',
    1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253',
    1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  } as Record<number, string>)[cp]
  if (!label) return null
  try { new TextDecoder(label); return label } catch { return null }
}

/** Lazily-detected OEM label, memoized. Resolved on the FIRST Bash command (not at import) so the
 *  synchronous `reg query` never blocks server startup; cached for every command after. */
let cachedOemLabel: string | null | undefined
export function winOemLabel(): string | null {
  if (cachedOemLabel === undefined) cachedOemLabel = detectWindowsOemLabel()
  return cachedOemLabel
}

/** Combined raw-byte cap for the OEM re-decode buffer; beyond it we keep the streamed UTF-8. */
export const OEM_RAW_CAP = 2_000_000
/** Re-decode as OEM only when replacement chars are at least this fraction of the UTF-8 body — i.e.
 *  the bytes are genuinely OEM, not clean UTF-8 with a few stray invalid bytes. */
const OEM_MOJIBAKE_RATIO = 0.02

/**
 * Re-decode child output in the Windows OEM codepage when UTF-8 decoding failed DENSELY — i.e. the
 * bytes are genuinely OEM-encoded native output (ping/dir/…), not clean UTF-8 with a few stray
 * invalid bytes. Gating on U+FFFD *density* (not "any U+FFFD") stops one stray replacement char from
 * flipping an otherwise-UTF-8 output (e.g. a build log) wholesale into OEM garbage. Returns the
 * re-decoded text, or null → keep the UTF-8 text. Concats the raw chunks only on the re-decode path
 * (after the early-returns), so a clean command pays no buffer copy. Exported for unit testing.
 *
 * Residual limitation: output that mixes real UTF-8 and OEM within ONE command is still decoded
 * whole by whichever encoding dominates — genuinely ambiguous without per-segment detection.
 *
 * 将来 run 服务需要**流式**输出，而这套判据只能在进程收尾（拿到完整 body）时判 ——
 * 边流边判会让前半截 UTF-8、后半截 OEM。此处保留一次性语义，待扩展。
 */
export function redecodeOemIfMojibake(
  utf8Body: string, rawChunks: Buffer[], overflow: boolean, oemLabel: string | null,
): string | null {
  if (!oemLabel || overflow || utf8Body.length === 0) return null
  const replacements = utf8Body.split(String.fromCharCode(0xfffd)).length - 1 // count U+FFFD
  if (replacements / utf8Body.length < OEM_MOJIBAKE_RATIO) return null
  try { return new TextDecoder(oemLabel).decode(Buffer.concat(rawChunks)) } catch { return null }
}
