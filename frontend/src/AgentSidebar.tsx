import { MutableRefObject, useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Editor, createShapeId, TLShapeId, toRichText } from 'tldraw'
import { streamMessage, StreamAction, CanvasShape } from './api'

interface AgentSidebarProps {
  editorRef: MutableRefObject<Editor | null>
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}


function getCanvasState(editor: Editor): CanvasShape[] {
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

/** Convert agent-assigned shapeId → tldraw TLShapeId */
function agentId(id: string): TLShapeId {
  return (id.startsWith('shape:') ? id : `shape:${id}`) as TLShapeId
}

function applyAction(editor: Editor, action: StreamAction) {
  const t = action._type

  if (t === 'create_note') {
    const id = action.shapeId ? agentId(action.shapeId as string) : createShapeId()
    editor.createShapes([{
      id,
      type: 'note',
      x: action.x as number,
      y: action.y as number,
      props: {
        richText: toRichText((action.text as string) ?? ''),
        color: ((action.color as string) ?? 'yellow') as any,
        size: 'm',
      },
    }])

  } else if (t === 'create_shape') {
    const id = action.shapeId ? agentId(action.shapeId as string) : createShapeId()
    editor.createShapes([{
      id,
      type: 'geo',
      x: action.x as number,
      y: action.y as number,
      props: {
        geo: ((action.geo as string) ?? 'rectangle') as any,
        w: (action.w as number) ?? 160,
        h: (action.h as number) ?? 80,
        richText: toRichText((action.text as string) ?? ''),
        color: ((action.color as string) ?? 'blue') as any,
        fill: 'solid' as const,
      },
    }])

  } else if (t === 'create_text') {
    const id = action.shapeId ? agentId(action.shapeId as string) : createShapeId()
    editor.createShapes([{
      id,
      type: 'text',
      x: action.x as number,
      y: action.y as number,
      props: {
        richText: toRichText((action.text as string) ?? ''),
        color: ((action.color as string) ?? 'black') as any,
        size: 'm' as const,
        autoSize: true,
      },
    }])

  } else if (t === 'create_arrow') {
    const id = action.shapeId ? agentId(action.shapeId as string) : createShapeId()
    const x1 = (action.x1 as number) ?? 0
    const y1 = (action.y1 as number) ?? 0
    const x2 = (action.x2 as number) ?? 200
    const y2 = (action.y2 as number) ?? 0
    const minX = Math.min(x1, x2)
    const minY = Math.min(y1, y2)

    editor.createShapes([{
      id,
      type: 'arrow',
      x: minX,
      y: minY,
      props: {
        start: { x: x1 - minX, y: y1 - minY },
        end: { x: x2 - minX, y: y2 - minY },
        richText: toRichText((action.text as string) ?? ''),
        color: ((action.color as string) ?? 'black') as any,
        arrowheadEnd: 'arrow' as const,
        arrowheadStart: 'none' as const,
        bend: 0,
      },
    }])

    // Bind arrow endpoints to referenced shapes
    const bindings: Parameters<typeof editor.createBindings>[0] = []
    if (action.fromId) {
      const fromId = agentId(action.fromId as string)
      if (editor.getShape(fromId)) {
        bindings.push({
          type: 'arrow',
          fromId: id,
          toId: fromId,
          props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
        })
      }
    }
    if (action.toId) {
      const toId = agentId(action.toId as string)
      if (editor.getShape(toId)) {
        bindings.push({
          type: 'arrow',
          fromId: id,
          toId: toId,
          props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
        })
      }
    }
    if (bindings.length > 0) editor.createBindings(bindings)

  } else if (t === 'move_shape') {
    const id = action.id as TLShapeId
    const shape = editor.getShape(id)
    if (shape) {
      editor.updateShapes([{ id: shape.id, type: shape.type, x: action.x as number, y: action.y as number }])
    }
  } else if (t === 'update_text') {
    const id = action.id as TLShapeId
    const shape = editor.getShape(id)
    if (shape) {
      editor.updateShapes([{ id: shape.id, type: shape.type, props: { richText: toRichText(action.text as string) } } as any])
    }
  } else if (t === 'delete_shape') {
    editor.deleteShapes([action.id as TLShapeId])
  }
  // 'message' is handled in the sidebar
}

export default function AgentSidebar({ editorRef }: AgentSidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm your AI brainstorm partner. Tell me what to add to the canvas — I can create sticky notes, shapes, move things around, and help organize ideas.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading || !editorRef.current) return

    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)

    const canvasState = getCanvasState(editorRef.current)
    let gotMessage = false

    await streamMessage(
      text,
      canvasState,
      (action) => {
        if (action._type === 'message') {
          gotMessage = true
          setMessages((prev) => [...prev, { role: 'assistant', content: action.text as string }])
        } else if (editorRef.current) {
          applyAction(editorRef.current, action)
        }
      },
      () => {
        if (!gotMessage) {
          setMessages((prev) => [...prev, { role: 'assistant', content: 'Done!' }])
        }
        setLoading(false)
      },
      (err) => {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Error: ${err.message}` },
        ])
        setLoading(false)
      }
    )
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <span style={styles.headerDot} />
        AI Agent
      </div>

      <div style={styles.messages}>
        {messages.map((msg, i) => (
          <div key={i} style={msg.role === 'user' ? styles.userMsg : styles.assistantMsg}>
            {msg.role === 'assistant' && <div style={styles.agentLabel}>AI</div>}
            <div style={msg.role === 'user' ? styles.userBubble : styles.assistantBubble}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={styles.assistantMsg}>
            <div style={styles.agentLabel}>AI</div>
            <div style={styles.assistantBubble}>
              <span style={styles.typing}>thinking…</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={styles.inputArea}>
        <textarea
          style={styles.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent… (Enter to send)"
          rows={3}
          disabled={loading}
        />
        <button style={styles.button} onClick={handleSend} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    width: '320px',
    height: '100%',
    background: '#1a1a2e',
    display: 'flex',
    flexDirection: 'column',
    borderLeft: '1px solid #2a2a4a',
    fontFamily: 'system-ui, sans-serif',
    color: '#e0e0f0',
  },
  header: {
    padding: '14px 16px',
    borderBottom: '1px solid #2a2a4a',
    fontWeight: 600,
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: '#16213e',
  },
  headerDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#4ade80',
    display: 'inline-block',
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  userMsg: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  assistantMsg: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  agentLabel: {
    fontSize: '10px',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  userBubble: {
    background: '#4f46e5',
    color: '#fff',
    borderRadius: '12px 12px 2px 12px',
    padding: '8px 12px',
    maxWidth: '80%',
    fontSize: '13px',
    lineHeight: '1.5',
    wordBreak: 'break-word',
  },
  assistantBubble: {
    background: '#1e293b',
    color: '#cbd5e1',
    borderRadius: '2px 12px 12px 12px',
    padding: '8px 12px',
    maxWidth: '95%',
    fontSize: '13px',
    lineHeight: '1.5',
    wordBreak: 'break-word',
  },
  typing: {
    color: '#6b7280',
    fontStyle: 'italic',
  },
  inputArea: {
    padding: '12px',
    borderTop: '1px solid #2a2a4a',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    background: '#16213e',
  },
  textarea: {
    background: '#0f172a',
    color: '#e0e0f0',
    border: '1px solid #334155',
    borderRadius: '8px',
    padding: '8px 10px',
    fontSize: '13px',
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: '1.5',
  },
  button: {
    background: '#4f46e5',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 0',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    opacity: 1,
  },
}
