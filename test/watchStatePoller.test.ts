import { describe, it, expect, beforeEach, vi } from "vitest"

describe("parsePollInterval", () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.WATCH_POLL_INTERVAL
  })

  async function getParsePollInterval() {
    const mod = await import("../src/services/watchStatePoller.js")
    return mod.parsePollInterval
  }

  it("returns 0 when env var is not set", async () => {
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(0)
  })

  it("returns 0 when env var is '0'", async () => {
    process.env.WATCH_POLL_INTERVAL = "0"
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(0)
  })

  it("returns 0 when env var is empty string", async () => {
    process.env.WATCH_POLL_INTERVAL = ""
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(0)
  })

  it("converts seconds to milliseconds for valid values", async () => {
    process.env.WATCH_POLL_INTERVAL = "60"
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(60000)
  })

  it("converts small valid values", async () => {
    process.env.WATCH_POLL_INTERVAL = "5"
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(5000)
  })

  it("returns 0 (disabled) for invalid string 'foo'", async () => {
    process.env.WATCH_POLL_INTERVAL = "foo"
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(0)
  })

  it("returns 0 (disabled) for negative values", async () => {
    process.env.WATCH_POLL_INTERVAL = "-5"
    const parsePollInterval = await getParsePollInterval()
    expect(parsePollInterval()).toBe(0)
  })
})
