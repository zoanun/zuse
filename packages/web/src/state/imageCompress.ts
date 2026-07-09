/** 压缩结果：blob + 规范化 mediaType。 */
export interface CompressedImage { blob: Blob; mediaType: string }

/** 长边像素上限——照 CC，把每图视觉 token 摁在 ~1.6k、请求不过大。 */
export const MAX_EDGE = 1568

/**
 * 用 canvas 把图等比缩到长边 ≤ MAX_EDGE：PNG 源保 PNG（存透明），其余导出 JPEG(q=0.85)。
 *
 * 依赖浏览器 API（Image / canvas / createObjectURL）——jsdom 不可用，故与 uploadImage 分离；
 * 测试时对 uploadImage 注入 mock 压缩函数，不测本函数。
 */
export async function compressImage(file: File): Promise<CompressedImage> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(img, 0, 0, w, h)
    const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    const blob = await canvasToBlob(canvas, mediaType, 0.85)
    return { blob, mediaType }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 返回空'))),
      type,
      quality,
    )
  })
}
