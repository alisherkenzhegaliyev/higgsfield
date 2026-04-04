export type CanvasShape = {
  id: string
  type: string
  x: number
  y: number
  text: string
  color: string
  w?: number
  h?: number
  geo?: string
}

// Raw action from the stream (uses _type discriminator)
export type StreamAction = Record<string, unknown> & { _type: string }

/** Proxy a Higgsfield CDN URL through the local backend to avoid CORS. */
export function proxyUrl(url: string): string {
  return `http://localhost:8000/api/proxy-media?url=${encodeURIComponent(url)}`
}

export type GenerationStatus = {
  status: string
  url?: string | null
  error?: string
}

export async function streamMessage(
  message: string,
  canvasState: CanvasShape[],
  onAction: (action: StreamAction) => void,
  onDone: () => void,
  onError: (err: Error) => void
): Promise<void> {
  let response: Response
  try {
    response = await fetch('http://localhost:8000/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, canvas_state: canvasState }),
    })
  } catch (e) {
    onError(e instanceof Error ? e : new Error('Network error'))
    return
  }

  if (!response.ok) {
    onError(new Error(`Backend error: ${response.status}`))
    return
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue

        let event: { type: string; action?: StreamAction; error?: string }
        try {
          event = JSON.parse(raw)
        } catch {
          continue
        }

        if (event.type === 'action' && event.action) {
          onAction(event.action)
        } else if (event.type === 'done') {
          onDone()
          return
        } else if (event.error) {
          onError(new Error(event.error))
          return
        }
      }
    }
  } catch (e) {
    onError(e instanceof Error ? e : new Error('Stream read error'))
  } finally {
    reader.releaseLock()
  }

  onDone()
}

export async function startGeneration(
  params: { type: 'image' | 'video'; prompt: string; x: number; y: number; image_url?: string },
  onStatusUpdate: (status: GenerationStatus) => void
): Promise<void> {
  let res: Response
  try {
    res = await fetch('http://localhost:8000/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
  } catch {
    onStatusUpdate({ status: 'failed', error: 'Network error' })
    return
  }

  const data = await res.json()
  if (data.error || !data.request_id) {
    onStatusUpdate({ status: 'failed', error: data.error ?? 'Unknown error' })
    return
  }

  const requestId = data.request_id as string

  // Subscribe to status SSE
  let sseRes: Response
  try {
    sseRes = await fetch(`http://localhost:8000/api/generation-status/${requestId}`)
  } catch {
    onStatusUpdate({ status: 'failed', error: 'Status stream error' })
    return
  }

  const reader = sseRes.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue

        try {
          const status = JSON.parse(raw) as GenerationStatus
          onStatusUpdate(status)
          if (status.status === 'completed' || status.status === 'failed') return
        } catch {
          continue
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
