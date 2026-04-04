import { useRef, useState, useCallback } from 'react'
import { Editor, TLShapeId } from 'tldraw'
import CanvasPane from './CanvasPane'
import AgentSidebar from './AgentSidebar'
import { GenerationContext, PendingGeneration, ThinkingGeneration, GenerationSettings, DEFAULT_SETTINGS } from './GenerationContext'

export default function App() {
  const editorRef = useRef<Editor | null>(null)
  const [pendingGenerations, setPendingGenerations] = useState<PendingGeneration[]>([])
  const [thinkingGenerations, setThinkingGenerations] = useState<ThinkingGeneration[]>([])
  const [settings, setSettingsState] = useState<GenerationSettings>(DEFAULT_SETTINGS)

  const setSettings = useCallback((patch: Partial<GenerationSettings>) => {
    setSettingsState((prev) => ({ ...prev, ...patch }))
  }, [])

  const onThinkingStart = useCallback((gen: ThinkingGeneration) => {
    setThinkingGenerations((prev) => [...prev, gen])
  }, [])

  const onThinkingEnd = useCallback((id: string) => {
    setThinkingGenerations((prev) => prev.filter((g) => g.id !== id))
  }, [])

  const onGenerationComplete = useCallback((gen: PendingGeneration) => {
    setPendingGenerations((prev) => [...prev, gen])
  }, [])

  const onApprove = useCallback((shapeId: string, type: 'image' | 'video') => {
    editorRef.current?.updateShapes([{ id: shapeId as TLShapeId, type, opacity: 1 }])
    setPendingGenerations((prev) => prev.filter((g) => g.shapeId !== shapeId))
  }, [])

  const onDismiss = useCallback((shapeId: string) => {
    editorRef.current?.deleteShapes([shapeId as TLShapeId])
    setPendingGenerations((prev) => prev.filter((g) => g.shapeId !== shapeId))
  }, [])

  return (
    <GenerationContext.Provider
      value={{ pendingGenerations, thinkingGenerations, settings, setSettings, onGenerationComplete, onThinkingStart, onThinkingEnd, onApprove, onDismiss }}
    >
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <CanvasPane editorRef={editorRef} />
        </div>
        <AgentSidebar editorRef={editorRef} />
      </div>
    </GenerationContext.Provider>
  )
}
