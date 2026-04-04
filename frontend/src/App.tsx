import { useRef, useMemo, useCallback, useEffect } from 'react'
import { Editor } from 'tldraw'
import CanvasPane from './CanvasPane'
import AgentSidebar from './AgentSidebar'
import VoiceChat from './VoiceChat'
import { StreamAction } from './api'
import { getCanvasState } from './canvasUtils'
import { useVoiceChat, VoiceChatCallbacks } from './useVoiceChat'

const ADJECTIVES = ['Quick', 'Bold', 'Calm', 'Dark', 'Free', 'Sharp', 'Wild', 'Cool', 'Swift', 'Bright']
const NOUNS = ['Panda', 'Tiger', 'Eagle', 'Wolf', 'Fox', 'Bear', 'Hawk', 'Lynx', 'Otter', 'Raven']

function getOrCreateUsername(): string {
  const key = 'vc_username'
  // sessionStorage: per-tab so two browser tabs get different usernames
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

  // applyAction is wired up by AgentSidebar via this ref.
  const applyActionRef = useRef<((action: StreamAction) => void) | null>(null)

  const handleAgentAction = useCallback((action: StreamAction) => {
    applyActionRef.current?.(action)
    // Store listener fires automatically within ~1s of any canvas change,
    // which covers agent actions too — no need to sync manually here.
  }, [])

  const handleCanvasRestoreFull = useCallback((snapshot: unknown) => {
    if (editorRef.current && snapshot) {
      try {
        editorRef.current.loadSnapshot(snapshot as Parameters<Editor['loadSnapshot']>[0])
      } catch (e) {
        console.warn('[canvas_restore_full] loadSnapshot failed', e)
      }
    }
  }, [])

  const handleCanvasSnapshot = useCallback((shapes: unknown[]) => {
    for (const shape of shapes as any[]) {
      const actionType =
        shape.type === 'note' ? 'create_note'
        : shape.type === 'text' ? 'create_text'
        : shape.type === 'arrow' ? 'create_arrow'
        : 'create_shape'
      handleAgentAction({ _type: actionType, shapeId: shape.id, ...shape } as StreamAction)
    }
  }, [handleAgentAction])

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

  // Debounced store listener: sync full tldraw snapshot + simplified shapes
  // to backend whenever anything on the canvas changes (agent or manual).
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

    // Poll until the editor is mounted, then attach the store listener.
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
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <CanvasPane editorRef={editorRef} />
        <VoiceChat
          users={users}
          transcripts={transcripts}
          isMuted={isMuted}
          isConnected={isConnected}
          isListenerActive={isListenerActive}
          toggleMute={toggleMute}
          username={username}
        />
      </div>
      <AgentSidebar editorRef={editorRef} applyActionRef={applyActionRef} />
    </div>
  )
}
