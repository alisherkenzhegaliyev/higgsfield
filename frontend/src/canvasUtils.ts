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
    }
  })
}
