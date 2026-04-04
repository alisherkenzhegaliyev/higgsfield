import { useRef, useState, useCallback, useEffect, useMemo } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Editor, TLShapeId, createShapeId, AssetRecordType } from 'tldraw'
import CanvasPane from './CanvasPane'
import AgentSidebar, { applyAction } from './AgentSidebar'
import VoiceChat from './VoiceChat'
import HeaderBar from './HeaderBar'
import {
  GenerationContext,
  PendingGeneration,
  ThinkingGeneration,
  GenerationSettings,
  DEFAULT_SETTINGS,
} from './GenerationContext'
import { useVoiceChat, VoiceChatCallbacks } from './useVoiceChat'
import { getCanvasState } from './canvasUtils'
import { StreamAction, proxyUrl } from './api'

const ADJECTIVES = ['Quick', 'Bold', 'Calm', 'Dark', 'Free', 'Sharp', 'Wild', 'Cool', 'Swift', 'Bright']
const NOUNS = ['Panda', 'Tiger', 'Eagle', 'Wolf', 'Fox', 'Bear', 'Hawk', 'Lynx', 'Otter', 'Raven']

function getOrCreateUsername(): string {
  const key = 'vc_username'
  const stored = sessionStorage.getItem(key)
  if (stored) return stored
  const name =
    ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] +
    ' ' +
    NOUNS[Math.floor(Math.random() * NOUNS.length)]
  sessionStorage.setItem(key, name)
  return name
}

export default function App() {
  const editorRef = useRef<Editor | null>(null)
  const username = useMemo(() => getOrCreateUsername(), [])
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // ── Generation state ─────────────────────────────────────────────────────────
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

  // ── Voice agent: generate_complete handler ───────────────────────────────────
  const handleGenerateComplete = useCallback(
    (action: StreamAction) => {
      const editor = editorRef.current
      if (!editor) return
      const { shapeId, url, x, y, w, h, media_type, prompt } = action as any
      const isVideo = (media_type as string) === 'video'
      const proxied = proxyUrl(url as string)

      const placeholderId = `shape:${shapeId}` as TLShapeId
      if (editor.getShape(placeholderId)) editor.deleteShapes([placeholderId])

      const newShapeId = createShapeId()
      const assetId = AssetRecordType.createId()
      editor.createAssets([{
        id: assetId, typeName: 'asset', type: isVideo ? 'video' : 'image',
        props: {
          src: proxied, w: w ?? 320, h: h ?? 220,
          mimeType: isVideo ? 'video/mp4' : 'image/png',
          name: 'generated', isAnimated: isVideo,
        },
        meta: { originalUrl: url },
      }])
      editor.createShapes([{
        id: newShapeId, type: isVideo ? 'video' : 'image',
        x: x ?? 200, y: y ?? 200, opacity: 0.4,
        props: {
          assetId, w: w ?? 320, h: h ?? 220,
          ...(isVideo ? { playing: true, url: '' } : {}),
        },
      }])
      onGenerationComplete({
        shapeId: newShapeId as unknown as string,
        assetId: assetId as unknown as string,
        x: x ?? 200, y: y ?? 200, w: w ?? 320, h: h ?? 220,
        prompt: prompt ?? '', mediaUrl: url as string,
        type: isVideo ? 'video' : 'image',
      })
    },
    [onGenerationComplete],
  )

  // ── Voice agent: general action handler ──────────────────────────────────────
  const handleAgentAction = useCallback(
    (action: StreamAction) => {
      if (action._type === 'generate_complete') {
        handleGenerateComplete(action)
        return
      }
      const editor = editorRef.current
      if (editor) applyAction(editor, action, onGenerationComplete, onThinkingStart, onThinkingEnd, settings)
    },
    [handleGenerateComplete, onGenerationComplete, onThinkingStart, onThinkingEnd, settings],
  )

  const handleCanvasRestoreFull = useCallback((snapshot: unknown) => {
    if (editorRef.current && snapshot) {
      try {
        editorRef.current.loadSnapshot(snapshot as Parameters<Editor['loadSnapshot']>[0])
      } catch (e) {
        console.warn('[canvas_restore_full] failed', e)
      }
    }
  }, [])

  const handleCanvasSnapshot = useCallback(
    (shapes: unknown[]) => {
      for (const shape of shapes as any[]) {
        const actionType =
          shape.type === 'note' ? 'create_note'
          : shape.type === 'text' ? 'create_text'
          : shape.type === 'arrow' ? 'create_arrow'
          : 'create_shape'
        handleAgentAction({ _type: actionType, shapeId: shape.id, ...shape } as StreamAction)
      }
    },
    [handleAgentAction],
  )

  const callbacks: VoiceChatCallbacks = useMemo(
    () => ({
      onAgentAction: handleAgentAction,
      onCanvasRestoreFull: handleCanvasRestoreFull,
      onCanvasSnapshot: handleCanvasSnapshot,
    }),
    [handleAgentAction, handleCanvasRestoreFull, handleCanvasSnapshot],
  )

  const { users, transcripts, isMuted, isConnected, isListenerActive, toggleMute, sendWsMessage } =
    useVoiceChat('main', username, callbacks)

  // ── Canvas sync: debounced store listener ────────────────────────────────────
  const storeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!isConnected) return
    let timer: ReturnType<typeof setTimeout>

    function syncCanvas() {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!editorRef.current) return
        try {
          const snapshot = editorRef.current.getSnapshot()
          sendWsMessage({ type: 'canvas_snapshot_full', snapshot })
          sendWsMessage({ type: 'canvas_state', state: getCanvasState(editorRef.current) })
        } catch (e) {
          console.warn('[store listener] sync failed', e)
        }
      }, 1000)
    }

    const pollInterval = setInterval(() => {
      if (!editorRef.current) return
      clearInterval(pollInterval)
      const unsubscribe = editorRef.current.store.listen(syncCanvas)
      storeCleanupRef.current = () => {
        unsubscribe()
        clearTimeout(timer)
      }
    }, 100)

    return () => {
      clearInterval(pollInterval)
      storeCleanupRef.current?.()
      storeCleanupRef.current = null
    }
  }, [isConnected, sendWsMessage])

  return (
    <GenerationContext.Provider
      value={{
        pendingGenerations,
        thinkingGenerations,
        settings,
        setSettings,
        onGenerationComplete,
        onThinkingStart,
        onThinkingEnd,
        onApprove,
        onDismiss,
      }}
    >
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-background">
        {/* Header */}
        <HeaderBar
          users={users}
          username={username}
          isConnected={isConnected}
          isListenerActive={isListenerActive}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
        />

        {/* Body */}
        <div className="flex-1 flex min-h-0">
          {/* Main column: canvas + agent chat */}
          <div className="flex-1 min-w-0">
            <PanelGroup direction="vertical" className="h-full">
              <Panel defaultSize={68} minSize={30}>
                <div className="h-full p-2 pb-0">
                  <div className="relative w-full h-full rounded-lg overflow-hidden border border-border">
                    <CanvasPane editorRef={editorRef} />
                  </div>
                </div>
              </Panel>

              <PanelResizeHandle className="h-2 flex items-center justify-center group cursor-row-resize">
                <div className="w-12 h-1 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
              </PanelResizeHandle>

              <Panel defaultSize={32} minSize={8} collapsible>
                <AgentSidebar editorRef={editorRef} />
              </Panel>
            </PanelGroup>
          </div>

          {/* Right sidebar: voice + transcripts + generation settings */}
          <div
            className={`shrink-0 h-full transition-all duration-300 ease-in-out overflow-hidden ${
              sidebarOpen ? 'w-80 border-l border-border' : 'w-0'
            }`}
          >
            <div className="w-80 h-full">
              <VoiceChat
                users={users}
                transcripts={transcripts}
                isMuted={isMuted}
                isConnected={isConnected}
                isListenerActive={isListenerActive}
                toggleMute={toggleMute}
                username={username}
                settings={settings}
                setSettings={setSettings}
              />
            </div>
          </div>
        </div>
      </div>
    </GenerationContext.Provider>
  )
}
