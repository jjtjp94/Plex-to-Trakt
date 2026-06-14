import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"

// Mock prisma and traktScrobble before importing sessionTracker
vi.mock("../src/services/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}))

vi.mock("../src/services/traktScrobble.js", () => ({
  sendScrobble: vi.fn().mockResolvedValue(true),
  computeProgress: (offset: number, duration: number) => {
    if (!offset || !duration || duration <= 0) return 0
    const pct = (offset / duration) * 100
    return Math.min(100, Math.max(0, Math.round(pct * 100) / 100))
  },
}))

import {
  sessionKey,
  upsertSession,
  getSession,
  getActiveSessionCount,
  extrapolatedProgress,
  markPlexScrobbled,
  removeSession,
  markFinalized,
} from "../src/services/sessionTracker.js"

describe("sessionTracker", () => {
  afterEach(() => {
    // Clean up any sessions created during tests
    for (let i = 0; i < 100; i++) {
      removeSession(`test:player:${i}`)
    }
    removeSession("user1:player1:12345")
    removeSession("user1:player1:99999")
  })

  describe("sessionKey", () => {
    it("builds key from components", () => {
      expect(sessionKey("user1", "player1", "12345")).toBe("user1:player1:12345")
    })

    it("uses 'unknown' for undefined player", () => {
      expect(sessionKey("user1", undefined, "12345")).toBe("user1:unknown:12345")
    })
  })

  describe("upsertSession", () => {
    it("creates a new session", () => {
      const session = upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "12345",
        title: "Test Movie",
        mdType: "movie",
        ids: { tmdb: 42 },
        durationMs: 7200000,
        state: "playing",
        progress: 10,
      })

      expect(session.key).toBe("user1:player1:12345")
      expect(session.title).toBe("Test Movie")
      expect(session.state).toBe("playing")
      expect(session.progress).toBe(10)
      expect(session.finalized).toBe(false)
      expect(session.plexScrobbled).toBe(false)
    })

    it("updates existing session, preserving lastPostAt", () => {
      const first = upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "12345",
        title: "Test Movie",
        mdType: "movie",
        ids: { tmdb: 42 },
        durationMs: 7200000,
        state: "playing",
        progress: 10,
      })

      first.lastPostAt = 5000

      const second = upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "12345",
        title: "Test Movie",
        mdType: "movie",
        ids: { tmdb: 42 },
        durationMs: 7200000,
        state: "paused",
        progress: 50,
      })

      expect(second.state).toBe("paused")
      expect(second.progress).toBe(50)
      expect(second.lastPostAt).toBe(5000)
    })
  })

  describe("extrapolatedProgress", () => {
    it("returns current progress when paused", () => {
      const session = upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "99999",
        title: "Paused Movie",
        mdType: "movie",
        ids: { tmdb: 1 },
        durationMs: 7200000,
        state: "paused",
        progress: 25,
      })
      expect(extrapolatedProgress(session)).toBe(25)
    })

    it("caps at 100", () => {
      const session = upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "99999",
        title: "Movie",
        mdType: "movie",
        ids: { tmdb: 1 },
        durationMs: 1000,
        state: "playing",
        progress: 99,
      })
      // Force updatedAt way in the past
      session.updatedAt = Date.now() - 100000
      expect(extrapolatedProgress(session)).toBe(100)
    })
  })

  describe("getActiveSessionCount", () => {
    it("counts active sessions", () => {
      const before = getActiveSessionCount()
      upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "12345",
        title: "Movie",
        mdType: "movie",
        ids: {},
        durationMs: 1000,
        state: "playing",
        progress: 0,
      })
      expect(getActiveSessionCount()).toBe(before + 1)
    })
  })

  describe("removeSession", () => {
    it("removes a session by key", () => {
      upsertSession({
        prismaUserId: 1,
        plexAccountId: "user1",
        playerUuid: "player1",
        ratingKey: "12345",
        title: "Movie",
        mdType: "movie",
        ids: {},
        durationMs: 1000,
        state: "playing",
        progress: 0,
      })
      removeSession("user1:player1:12345")
      expect(getSession("user1:player1:12345")).toBeUndefined()
    })
  })
})
