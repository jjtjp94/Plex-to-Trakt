export type EventType =
  | "scrobble"
  | "watched"
  | "sync_start"
  | "sync_complete"
  | "sync_error"
  | "websocket_event"
  | "status"
  | "progress"

export interface AppEvent {
  type: EventType
  data: Record<string, any>
  timestamp: number
}

type Listener = (event: AppEvent) => void

const history: AppEvent[] = []
const listeners = new Set<Listener>()

export function emit(event: AppEvent): void {
  const bufferSize = parseInt(process.env.ACTIVITY_BUFFER_SIZE || "100", 10)
  history.push(event)
  if (history.length > bufferSize) history.shift()
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {}
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getHistory(): AppEvent[] {
  return [...history]
}
