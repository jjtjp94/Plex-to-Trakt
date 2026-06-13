import express from "express"
import { prisma } from "../services/prisma.js"
import { getWebSocketState } from "../services/plexWebSocket.js"
import { getHistory } from "../services/eventBus.js"

const router = express.Router()

// GET /api/status — system health overview
router.get("/", async (_req, res) => {
  let plexConnected = false
  let plexServerUrl = process.env.PLEX_SERVER_URL || null

  if (plexServerUrl) {
    try {
      const axios = (await import("axios")).default
      const token = process.env.PLEX_TOKEN
      if (token) {
        await axios.get(`${plexServerUrl.replace(/\/$/, "")}/identity`, {
          headers: { "X-Plex-Token": token, Accept: "application/json" },
          timeout: 5_000,
        })
        plexConnected = true
      }
    } catch {}
  }

  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null } },
    select: { plexUsername: true, traktExpiresAt: true },
  })

  const traktUser = users[0]
  const wsState = getWebSocketState()

  const syncInterval = process.env.SYNC_INTERVAL || null
  const lastSyncEvent = getHistory()
    .filter((e) => e.type === "sync_complete" || e.type === "sync_error")
    .pop()

  res.json({
    plex: {
      connected: plexConnected,
      serverUrl: plexServerUrl,
    },
    trakt: {
      connected: !!traktUser,
      username: traktUser?.plexUsername || null,
      tokenExpiresAt: traktUser?.traktExpiresAt || null,
    },
    websocket: {
      connected: wsState.connected,
      state: wsState.state,
      reconnectCount: wsState.reconnectCount,
      lastMessage: wsState.lastMessageAt ? new Date(wsState.lastMessageAt).toISOString() : null,
    },
    sync: {
      lastResult: lastSyncEvent?.data || null,
      interval: syncInterval,
    },
    activeSessions: 0,
  })
})

// GET /api/activity — ring buffer contents
router.get("/activity", (_req, res) => {
  const limit = parseInt(String(_req.query.limit) || "50", 10)
  const events = getHistory().reverse().slice(0, limit)
  res.json(events)
})

export default router
