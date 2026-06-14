import { describe, it, expect, beforeEach, vi } from "vitest"

let eventBus: typeof import("../src/services/eventBus.js")

describe("eventBus", () => {
  beforeEach(async () => {
    vi.resetModules()
    delete process.env.ACTIVITY_BUFFER_SIZE
    eventBus = await import("../src/services/eventBus.js")
  })

  it("emit adds event to history", () => {
    eventBus.emit({ type: "scrobble", data: { title: "Test" }, timestamp: 1000 })
    const history = eventBus.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].type).toBe("scrobble")
  })

  it("subscribe receives emitted events", () => {
    const received: any[] = []
    eventBus.subscribe((e) => received.push(e))
    eventBus.emit({ type: "watched", data: {}, timestamp: 2000 })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("watched")
  })

  it("unsubscribe stops receiving events", () => {
    const received: any[] = []
    const unsub = eventBus.subscribe((e) => received.push(e))
    eventBus.emit({ type: "watched", data: {}, timestamp: 1 })
    unsub()
    eventBus.emit({ type: "watched", data: {}, timestamp: 2 })
    expect(received).toHaveLength(1)
  })

  it("getHistory returns a copy", () => {
    eventBus.emit({ type: "scrobble", data: {}, timestamp: 1 })
    const h1 = eventBus.getHistory()
    const h2 = eventBus.getHistory()
    expect(h1).not.toBe(h2)
    expect(h1).toEqual(h2)
  })

  it("buffer caps at ACTIVITY_BUFFER_SIZE (default 100)", () => {
    for (let i = 0; i < 110; i++) {
      eventBus.emit({ type: "scrobble", data: { i }, timestamp: i })
    }
    const history = eventBus.getHistory()
    expect(history.length).toBeLessThanOrEqual(100)
  })
})
