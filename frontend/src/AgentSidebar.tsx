import { MutableRefObject, useState, useRef, useEffect, KeyboardEvent } from 'react'
import { Editor, createShapeId, TLShapeId, toRichText, AssetRecordType } from 'tldraw'
import { streamMessage, startGeneration, proxyUrl, StreamAction, CanvasShape } from './api'
import { useGenerationContext, GenerationSettings } from './GenerationContext'

const TRIGGER_KEYWORDS = [
  'moodboard', 'mood board', 'inspiration', 'aesthetic',
  'vibe', 'pinterest', 'references', 'visual style',
]

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

/** Find a free position near (nearX, nearY) that doesn't overlap existing shapes. */
function findFreePosition(
  editor: Editor,
  nearX: number,
  nearY: number,
  excludeId?: TLShapeId
): { x: number; y: number } {
  const shapes = editor.getCurrentPageShapes().filter((s) => s.id !== excludeId)
  const SIZE = 64
  const offsets = [
    [-90, -90], [0, -110], [90, -90],
    [-110, 0], [110, 0],
    [-90, 90], [0, 110], [90, 90],
  ]
  for (const [dx, dy] of offsets) {
    const x = nearX + dx
    const y = nearY + dy
    const clear = shapes.every((shape) => {
      const b = editor.getShapePageBounds(shape)
      if (!b) return true
      return x + SIZE < b.minX || x > b.maxX || y + SIZE < b.minY || y > b.maxY
    })
    if (clear) return { x, y }
  }
  return { x: nearX - 90, y: nearY - 110 }
}

/** Compute canvas dimensions from an aspect ratio string like "16:9" or "9:16". */
function dimensionsFromAspectRatio(aspectRatio: string): { w: number; h: number } {
  const [wr, hr] = aspectRatio.split(':').map(Number)
  if (!wr || !hr) return { w: 640, h: 360 }
  const BASE = 640
  // portrait: fix height; landscape/square: fix width
  if (hr > wr) return { w: Math.round(BASE * wr / hr), h: BASE }
  return { w: BASE, h: Math.round(BASE * hr / wr) }
}

/** Move or create the persistent AI circle near the given canvas coordinates. */
function ensureAiCircle(
  editor: Editor,
  circleRef: { current: TLShapeId | null },
  nearX: number,
  nearY: number
) {
  const pos = findFreePosition(editor, nearX, nearY, circleRef.current ?? undefined)
  if (circleRef.current && editor.getShape(circleRef.current)) {
    editor.updateShapes([{ id: circleRef.current, type: 'geo', x: pos.x, y: pos.y }])
  } else {
    const id = createShapeId()
    editor.createShapes([{
      id,
      type: 'geo',
      x: pos.x,
      y: pos.y,
      props: {
        geo: 'ellipse' as const,
        w: 64, h: 64,
        richText: toRichText('AI'),
        color: 'violet' as any,
        fill: 'solid' as const,
      },
    }])
    circleRef.current = id
  }
}

export function applyAction(
  editor: Editor,
  action: StreamAction,
  onGenerationComplete: (gen: import('./GenerationContext').PendingGeneration) => void,
  onThinkingStart: (gen: import('./GenerationContext').ThinkingGeneration) => void,
  onThinkingEnd: (id: string) => void,
  settings: GenerationSettings,
) {
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
  } else if (t === 'create_image') {
    const id = action.shapeId ? agentId(action.shapeId as string) : createShapeId()
    const rawUrl = action.url as string
    const proxyUrl = `http://localhost:8000/api/proxy-image?url=${encodeURIComponent(rawUrl)}`
    const w = (action.w as number) ?? 160
    const h = (action.h as number) ?? 200

    const assetId = AssetRecordType.createId()
    editor.createAssets([{
      id: assetId,
      type: 'image',
      typeName: 'asset',
      props: {
        name: 'pinterest-image',
        src: proxyUrl,
        w,
        h,
        mimeType: 'image/jpeg',
        isAnimated: false,
      },
      meta: {},
    }])
    editor.createShapes([{
      id,
      type: 'image',
      x: action.x as number,
      y: action.y as number,
      props: { assetId, w, h },
    }])

  } else if (t === 'delete_shape') {
    editor.deleteShapes([action.id as TLShapeId])

  } else if (t === 'generate_image') {
    const x = (action.x as number) ?? 200
    const y = (action.y as number) ?? 200
    const prompt = (action.prompt as string) ?? ''
    const thinkingId = `thinking-img-${Date.now()}`
    const { w, h } = dimensionsFromAspectRatio(settings.imageAspectRatio)

    // Canvas placeholder — shows exactly where the image will land
    const placeholderId = createShapeId()
    editor.createShapes([{
      id: placeholderId,
      type: 'geo',
      x, y,
      props: {
        geo: 'rectangle' as const,
        w, h,
        richText: toRichText(`Generating image…\n"${prompt.slice(0, 80)}"`),
        color: 'violet' as any,
        fill: 'semi' as const,
        dash: 'dashed' as const,
      },
    }])

    onThinkingStart({ id: thinkingId, x, y, w, h, prompt, type: 'image' })

    startGeneration({
      type: 'image', prompt, x, y,
      model: settings.imageModel,
      resolution: settings.imageResolution,
      aspect_ratio: settings.imageAspectRatio,
    }, (status) => {
      if (status.status !== 'completed' && status.status !== 'failed') return
      onThinkingEnd(thinkingId)
      if (status.status === 'failed') {
        editor.updateShapes([{
          id: placeholderId, type: 'geo',
          props: { richText: toRichText(`❌ Generation failed\n${status.error ?? ''}`), color: 'red' as any },
        }])
        return
      }
      editor.deleteShapes([placeholderId])
      if (status.url) {
        const imageId = createShapeId()
        const assetId = AssetRecordType.createId()
        editor.createAssets([{
          type: 'image', id: assetId, typeName: 'asset',
          props: { w, h, name: prompt.slice(0, 40), isAnimated: false, mimeType: 'image/png', src: proxyUrl(status.url!) },
          meta: { originalUrl: status.url },
        }])
        editor.createShapes([{
          id: imageId, type: 'image', x, y, opacity: 0.4,
          props: { w, h, assetId, playing: false, url: '', crop: null, flipX: false, flipY: false },
        }])
        onGenerationComplete({
          shapeId: imageId as unknown as string,
          assetId: assetId as unknown as string,
          x, y, w, h, prompt, mediaUrl: status.url, type: 'image',
        })
      }
    })

  } else if (t === 'generate_video') {
    const x = (action.x as number) ?? 400
    const y = (action.y as number) ?? 200
    const prompt = (action.prompt as string) ?? ''
    const sourceShapeId = action.sourceImageShapeId
      ? agentId(action.sourceImageShapeId as string)
      : undefined

    let imageUrl: string | undefined
    if (sourceShapeId) {
      const srcShape = editor.getShape(sourceShapeId)
      if (srcShape) {
        const srcProps = srcShape.props as Record<string, unknown>
        if (srcProps.assetId) {
          const asset = editor.getAsset(srcProps.assetId as any)
          if (asset?.props && 'src' in asset.props) {
            imageUrl = asset.props.src as string
          }
        }
      }
    }

    if (imageUrl) {
      const thinkingId = `thinking-vid-${Date.now()}`

      const placeholderId = createShapeId()
      editor.createShapes([{
        id: placeholderId,
        type: 'geo',
        x, y,
        props: {
          geo: 'rectangle' as const,
          w: 640, h: 360,
          richText: toRichText(`Generating video…\n"${prompt.slice(0, 80)}"`),
          color: 'violet' as any,
          fill: 'semi' as const,
          dash: 'dashed' as const,
        },
      }])

      onThinkingStart({ id: thinkingId, x, y, w: 640, h: 360, prompt, type: 'video' })

      startGeneration({
        type: 'video', prompt, x, y, image_url: imageUrl,
        model: settings.videoModel,
        duration: settings.videoDuration,
      }, (status) => {
        if (status.status !== 'completed' && status.status !== 'failed') return
        onThinkingEnd(thinkingId)
        if (status.status === 'failed') {
          editor.updateShapes([{
            id: placeholderId, type: 'geo',
            props: { richText: toRichText(`❌ Generation failed\n${status.error ?? ''}`), color: 'red' as any },
          }])
          return
        }
        editor.deleteShapes([placeholderId])
        if (status.url) {
          const videoId = createShapeId()
          const assetId = AssetRecordType.createId()
          editor.createAssets([{
            type: 'video', id: assetId, typeName: 'asset',
            props: { w: 640, h: 360, name: prompt.slice(0, 40), isAnimated: true, mimeType: 'video/mp4', src: proxyUrl(status.url!) },
            meta: { originalUrl: status.url },
          }])
          editor.createShapes([{
            id: videoId, type: 'video', x, y, opacity: 0.4,
            props: { w: 640, h: 360, assetId, playing: true, url: '' },
          }])
          onGenerationComplete({
            shapeId: videoId as unknown as string,
            assetId: assetId as unknown as string,
            x, y, w: 640, h: 360, prompt, mediaUrl: status.url, type: 'video',
          })
        }
      })
    }
  }
  // 'message' is handled in the sidebar
}

export default function AgentSidebar({ editorRef }: AgentSidebarProps) {
  const { onGenerationComplete, onThinkingStart, onThinkingEnd, settings, setSettings } = useGenerationContext()
  const aiCircleRef = useRef<TLShapeId | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm your AI brainstorm partner. Chat with me, or just drop a sticky note on the canvas with words like \"moodboard\", \"inspiration\", or \"aesthetic\" — I'll automatically fetch images for you.",
    },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  // shapeId → text that was last successfully triggered (prevents duplicate fires)
  const triggeredShapes = useRef<Map<string, string>>(new Map())
  // Stable ref so the store listener always closes over the latest trigger fn
  const autoTriggerRef = useRef<(text: string, shapeId: TLShapeId) => void>(() => {})

  useEffect(() => { loadingRef.current = loading }, [loading])

  // Rebuild autoTriggerRef on every render so it always sees fresh state/refs
  useEffect(() => {
    autoTriggerRef.current = async (text: string, shapeId: TLShapeId) => {
      if (loadingRef.current || !editorRef.current) return
      triggeredShapes.current.set(shapeId, text)
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Spotted "${text.trim()}" — pulling images…` },
      ])
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
          if (!gotMessage) setMessages((prev) => [...prev, { role: 'assistant', content: 'Done!' }])
          setLoading(false)
        },
        (err) => {
          setMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${err.message}` }])
          setLoading(false)
        }
      )
    }
  })

  // Proactive canvas watcher.
  // Trigger condition: user STOPS editing a note (editingShapeId: someId → null)
  // AND the final text contains a trigger keyword AND it's new content since last fire.
  // This is the correct "blur" signal — no debounce, no mid-typing false positives.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null

    function extractNoteText(editor: Editor, shapeId: TLShapeId): string {
      const shape = editor.getShape(shapeId)
      if (!shape || shape.type !== 'note') return ''
      const props = shape.props as unknown as Record<string, unknown>
      const raw = props.richText ?? props.text
      if (typeof raw === 'string') return raw
      if (raw && typeof raw === 'object' && 'content' in raw) {
        const doc = raw as { content?: Array<{ content?: Array<{ text?: string }> }> }
        return (doc.content ?? [])
          .map((p) => (p.content ?? []).map((leaf) => leaf.text ?? '').join(''))
          .join('\n')
      }
      return ''
    }

    function hasTrigger(text: string): boolean {
      const lower = text.toLowerCase()
      return TRIGGER_KEYWORDS.some((kw) => lower.includes(kw))
    }

    const interval = setInterval(() => {
      const editor = editorRef.current
      if (!editor) return
      clearInterval(interval)

      unsubscribe = editor.store.listen((entry) => {
        for (const [, [prev, next]] of Object.entries(entry.changes.updated)) {
          const p = prev as unknown as Record<string, unknown>
          const n = next as unknown as Record<string, unknown>
          // Only care about page-state records that track the active editing shape
          if (n.typeName !== 'instance_page_state') continue

          const prevEditing = p.editingShapeId as TLShapeId | null
          const nextEditing = n.editingShapeId as TLShapeId | null

          // Fire only on the transition: was editing something → now editing nothing
          if (!prevEditing || nextEditing) continue

          const text = extractNoteText(editor, prevEditing)
          if (!hasTrigger(text)) continue

          // Skip if we already fired for this exact content
          if (triggeredShapes.current.get(prevEditing) === text) continue

          autoTriggerRef.current(text, prevEditing)
        }
      }, { scope: 'session', source: 'user' })
    }, 200)

    return () => {
      clearInterval(interval)
      unsubscribe?.()
    }
  }, [editorRef])

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
          // Move the AI circle to near the coordinates of whatever is being created
          const ax = (action.x as number) ?? (action.x1 as number) ?? null
          const ay = (action.y as number) ?? (action.y1 as number) ?? null
          if (ax !== null && ay !== null) {
            ensureAiCircle(editorRef.current, aiCircleRef, ax, ay)
          }
          applyAction(editorRef.current, action, onGenerationComplete, onThinkingStart, onThinkingEnd, settings)
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

      {/* ── Generation Settings ── */}
      <div style={styles.settingsPanel}>
        <div style={styles.settingsRow}>
          <span style={styles.settingsIcon}>🖼</span>
          <select style={styles.select} value={settings.imageModel} onChange={(e) => setSettings({ imageModel: e.target.value as any })}>
            <option value="seedream">Seedream v4</option>
            <option value="flux">Flux 2 Pro</option>
          </select>
          <select style={styles.select} value={settings.imageResolution} onChange={(e) => setSettings({ imageResolution: e.target.value })}>
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K">4K</option>
          </select>
          <select style={styles.select} value={settings.imageAspectRatio} onChange={(e) => setSettings({ imageAspectRatio: e.target.value })}>
            <option value="16:9">16:9</option>
            <option value="4:3">4:3</option>
            <option value="1:1">1:1</option>
            <option value="9:16">9:16</option>
          </select>
        </div>
        <div style={styles.settingsRow}>
          <span style={styles.settingsIcon}>🎬</span>
          <select style={styles.select} value={settings.videoModel} onChange={(e) => setSettings({ videoModel: e.target.value as any })}>
            <option value="dop_standard">DoP Standard</option>
            <option value="dop_turbo">DoP Turbo</option>
            <option value="kling">Kling 3.0</option>
          </select>
          <select style={styles.select} value={settings.videoDuration} onChange={(e) => setSettings({ videoDuration: Number(e.target.value) })}>
            <option value={3}>3s</option>
            <option value={5}>5s</option>
          </select>
        </div>
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
  settingsPanel: {
    padding: '8px 12px',
    borderTop: '1px solid #2a2a4a',
    background: '#12172a',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  settingsIcon: {
    fontSize: '13px',
    flexShrink: 0,
    width: '18px',
  },
  select: {
    flex: 1,
    background: '#1e293b',
    color: '#cbd5e1',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '3px 5px',
    fontSize: '11px',
    fontFamily: 'system-ui, sans-serif',
    cursor: 'pointer',
    outline: 'none',
    minWidth: 0,
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
