import express from "express"
import { prisma } from "../services/prisma.js"
import { getWebSocketState } from "../services/plexWebSocket.js"
import { getHistory } from "../services/eventBus.js"
import { getActiveSessionCount } from "../services/sessionTracker.js"
import { getSyncSchedulerState } from "../services/syncScheduler.js"
import { getPollerState } from "../services/watchStatePoller.js"

const router = express.Router()

router.get("/status", async (_req, res) => {
  let plexConnected = false
  const plexServerUrl = process.env.PLEX_SERVER_URL || null

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
  const syncState = getSyncSchedulerState()
  const pollerState = getPollerState()

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
      lastMessageAge: wsState.lastMessageAt ? Date.now() - wsState.lastMessageAt : null,
    },
    sync: {
      enabled: syncState.enabled,
      interval: syncState.interval,
      lastSyncAt: syncState.lastSyncAt || null,
      nextSyncAt: syncState.nextSyncAt || null,
      lastResult: lastSyncEvent?.data || null,
    },
    poller: {
      enabled: pollerState.enabled,
      intervalMs: pollerState.intervalMs,
      lastPollAt: pollerState.lastPollAt || null,
      seeded: pollerState.seeded,
    },
    activeSessions: getActiveSessionCount(),
    settings: {
      syncInterval: process.env.SYNC_INTERVAL || null,
      syncUnwatched: process.env.SYNC_UNWATCHED === "true",
      watchPollInterval: process.env.WATCH_POLL_INTERVAL || null,
      wsEnabled: process.env.WS_ENABLED !== "false",
      introDetection: process.env.INTRO_DETECTION_ENABLED === "true",
    },
  })
})

router.get("/activity", (_req, res) => {
  const limit = parseInt(String(_req.query.limit) || "50", 10)
  const events = getHistory().reverse().slice(0, limit)
  res.json(events)
})

export default router
