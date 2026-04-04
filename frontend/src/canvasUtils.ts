import { Editor } from 'tldraw'
import { CanvasShape } from './api'

export function getCanvasState(editor: Editor): CanvasShape[] {
  return editor.getCurrentPageShapes().map((shape) => {
    const props = shape.props as Record<string, unknown>
    let text = ''
    const rawText = props.text ?? props.richText
    if (typeof rawText === 'string') {
      text = rawText
    } else if (rawText && typeof rawText === 'object' && 'content' in rawText) {
      const doc = rawText as { content?: Array<{ content?: Array<{ text?: string }> }> }
      text = (doc.content ?? [])
        .map((p) => (p.content ?? []).map((leaf) => leaf.text ?? '').join(''))
        .join('\n')
    }
    // For image shapes, expose the original URL so the voice agent can use it for generate_video
    let url: string | undefined
    if (shape.type === 'image' && props.assetId) {
      const asset = editor.getAsset(props.assetId as any)
      if (asset?.props && 'src' in asset.props) {
        let src = asset.props.src as string
        // Unwrap proxy prefix to restore the original URL
        const proxyMatch = src.match(/\/api\/proxy-(?:image|media)\?url=(.+)/)
        url = proxyMatch ? decodeURIComponent(proxyMatch[1]) : src
      }
    }

    return {
      id: shape.id,
      type: shape.type,
      x: Math.round(shape.x),
      y: Math.round(shape.y),
      text,
      color: (props.color as string) ?? '',
      w: props.w as number | undefined,
      h: props.h as number | undefined,
      geo: props.geo as string | undefined,
      url,
    }
  })
}
