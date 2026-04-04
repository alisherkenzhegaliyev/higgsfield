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
