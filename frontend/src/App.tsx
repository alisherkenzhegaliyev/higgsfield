import { useRef } from 'react'
import { Editor } from 'tldraw'
import CanvasPane from './CanvasPane'
import AgentSidebar from './AgentSidebar'

export default function App() {
  const editorRef = useRef<Editor | null>(null)

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <CanvasPane editorRef={editorRef} />
      </div>
      <AgentSidebar editorRef={editorRef} />
    </div>
  )
}
