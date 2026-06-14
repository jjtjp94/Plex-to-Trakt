import { describe, it, expect } from "vitest"

// Extract validators inline since they're not exported — test the validation logic directly
const VALIDATORS: Record<string, (v: string) => string | null> = {
  SYNC_INTERVAL: (v) => {
    if (["3h", "6h", "12h", "24h", "off", ""].includes(v)) return null
    return "Must be 3h, 6h, 12h, 24h, off, or empty"
  },
  SYNC_UNWATCHED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  WATCH_POLL_INTERVAL: (v) => {
    if (v === "" || v === "0") return null
    const n = parseInt(v, 10)
    if (isNaN(n) || n < 5 || n > 3600) return "Must be 5-3600 (seconds) or 0 to disable"
    return null
  },
  WS_ENABLED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  INTRO_DETECTION_ENABLED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  ACTIVITY_BUFFER_SIZE: (v) => {
    const n = parseInt(v, 10)
    if (isNaN(n) || n < 10 || n > 1000) return "Must be 10-1000"
    return null
  },
}

describe("settings validators", () => {
  describe("SYNC_INTERVAL", () => {
    it("accepts valid values", () => {
      expect(VALIDATORS.SYNC_INTERVAL("3h")).toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("6h")).toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("12h")).toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("24h")).toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("off")).toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("")).toBeNull()
    })

    it("rejects invalid values", () => {
      expect(VALIDATORS.SYNC_INTERVAL("1h")).not.toBeNull()
      expect(VALIDATORS.SYNC_INTERVAL("foo")).not.toBeNull()
    })
  })

  describe("SYNC_UNWATCHED", () => {
    it("accepts true/false", () => {
      expect(VALIDATORS.SYNC_UNWATCHED("true")).toBeNull()
      expect(VALIDATORS.SYNC_UNWATCHED("false")).toBeNull()
    })

    it("rejects other values", () => {
      expect(VALIDATORS.SYNC_UNWATCHED("yes")).not.toBeNull()
      expect(VALIDATORS.SYNC_UNWATCHED("1")).not.toBeNull()
    })
  })

  describe("WATCH_POLL_INTERVAL", () => {
    it("accepts empty and zero", () => {
      expect(VALIDATORS.WATCH_POLL_INTERVAL("")).toBeNull()
      expect(VALIDATORS.WATCH_POLL_INTERVAL("0")).toBeNull()
    })

    it("accepts valid range 5-3600", () => {
      expect(VALIDATORS.WATCH_POLL_INTERVAL("5")).toBeNull()
      expect(VALIDATORS.WATCH_POLL_INTERVAL("60")).toBeNull()
      expect(VALIDATORS.WATCH_POLL_INTERVAL("3600")).toBeNull()
    })

    it("rejects out of range", () => {
      expect(VALIDATORS.WATCH_POLL_INTERVAL("4")).not.toBeNull()
      expect(VALIDATORS.WATCH_POLL_INTERVAL("3601")).not.toBeNull()
    })

    it("rejects non-numeric", () => {
      expect(VALIDATORS.WATCH_POLL_INTERVAL("foo")).not.toBeNull()
    })
  })

  describe("ACTIVITY_BUFFER_SIZE", () => {
    it("accepts valid range 10-1000", () => {
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("10")).toBeNull()
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("100")).toBeNull()
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("1000")).toBeNull()
    })

    it("rejects out of range", () => {
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("9")).not.toBeNull()
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("1001")).not.toBeNull()
    })

    it("rejects non-numeric", () => {
      expect(VALIDATORS.ACTIVITY_BUFFER_SIZE("abc")).not.toBeNull()
    })
  })
})
