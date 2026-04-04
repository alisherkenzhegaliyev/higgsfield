import { MutableRefObject } from 'react'
import { Tldraw, Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import GenerationOverlay from './GenerationOverlay'
import AnimationPanel from './AnimationPanel'

interface CanvasPaneProps {
  editorRef: MutableRefObject<Editor | null>
}

function CanvasOverlays() {
  return (
    <>
      <GenerationOverlay />
      <AnimationPanel />
    </>
  )
}

export default function CanvasPane({ editorRef }: CanvasPaneProps) {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <Tldraw
        licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY}
        onMount={(editor) => {
          editorRef.current = editor
        }}
        components={{ InFrontOfTheCanvas: CanvasOverlays }}
      />
    </div>
  )
}
