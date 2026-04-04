import { MutableRefObject } from 'react'
import { Tldraw, Editor } from 'tldraw'
import 'tldraw/tldraw.css'

interface CanvasPaneProps {
  editorRef: MutableRefObject<Editor | null>
}

export default function CanvasPane({ editorRef }: CanvasPaneProps) {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw
        onMount={(editor) => {
          editorRef.current = editor
        }}
      />
    </div>
  )
}
