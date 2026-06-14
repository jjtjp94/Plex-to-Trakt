import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { extractAllIds, type PlexItem } from "./plexApi.js"
import { emit } from "./eventBus.js"
import { traktHeaders, idKeys } from "./traktUtils.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const DEFAULT_POLL_MS = 15_000

let pollInterval = parsePollInterval()
let pollTimer: NodeJS.Timeout | null = null
let lastPollAt = 0

interface CachedState {
  viewCount: number
  lastViewedAt: number
}

const stateCache = new Map<string, CachedState>()
let seeded = false
let silentPollCount = 0
let totalCheckedSinceHeartbeat = 0
const HEARTBEAT_EVERY = 10

export function parsePollInterval(): number {
  const raw = process.env.WATCH_POLL_INTERVAL
  if (!raw || raw === "0") return 0
  const seconds = parseInt(raw, 10)
  if (isNaN(seconds) || seconds <= 0) {
    console.warn(`[watch-poll] Invalid WATCH_POLL_INTERVAL="${raw}" — disabling poller. Use a number 5-3600 (seconds) or 0 to disable.`)
    return 0
  }
  return seconds * 1000
}

export function getPollerState() {
  return { enabled: pollInterval > 0, intervalMs: pollInterval, lastPollAt, seeded }
}

export function restartPoller() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollInterval = parsePollInterval()
  if (pollInterval > 0 && process.env.PLEX_SERVER_URL) {
    pollTimer = setInterval(() => {
      pollRecentChanges(process.env.PLEX_SERVER_URL!).catch((e) =>
        console.error("[watch-poll] Error:", e.message)
      )
    }, pollInterval)
    console.log(`[watch-poll] Restarted with ${pollInterval / 1000}s interval`)
  }
}

async function removeFromTraktPlayback(user: any, ids: Record<string, any>, title: string) {
  const hdrs = traktHeaders(user)
  const keys = new Set(idKeys(ids))
  if (keys.size === 0) return

  const [moviePb, episodePb] = await Promise.all([
    axios.get(`${TRAKT_API}/sync/playback/movies`, { headers: hdrs, timeout: 15_000 }).then((r) => r.data || []).catch(() => []),
    axios.get(`${TRAKT_API}/sync/playback/episodes`, { headers: hdrs, timeout: 15_000 }).then((r) => r.data || []).catch(() => []),
  ])

  for (const pb of [...moviePb, ...episodePb]) {
    const pbIds = pb.movie?.ids || pb.episode?.ids || {}
    if (idKeys(pbIds).some((k) => keys.has(k))) {
      await axios.delete(`${TRAKT_API}/sync/playback/${pb.id}`, { headers: hdrs, timeout: 10_000 })
      console.log(`[watch-poll] "${title}" removed from Trakt continue watching`)
      return
    }
  }
}

async function syncItemToTrakt(user: any, ratingKey: string, item: any, prevViewCount: number) {
  const ids = extractAllIds(item.guid, item.Guid)
  if (Object.keys(ids).length === 0) return

  const mdType = item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : null
  if (!mdType) return

  const viewCount = Number(item.viewCount) || 0
  const title = item.title || "Unknown"
  const syncUnwatched = process.env.SYNC_UNWATCHED === "true"

  try {
    user = await refreshTraktToken(user)

    if (viewCount > prevViewCount) {
      console.log(`[watch-poll] "${title}" viewCount ${prevViewCount} -> ${viewCount}`)
      const body = mdType === "movie"
        ? { movies: [{ ids, title }] }
        : { episodes: [{ ids, title }] }
      await axios.post(`${TRAKT_API}/sync/history`, body, {
        headers: traktHeaders(user),
        timeout: 10_000,
      })
      console.log(`[watch-poll] "${title}" marked watched -> synced to Trakt`)
      emit({
        type: "websocket_event",
        data: { subtype: "mark_watched", title },
        timestamp: Date.now(),
      })
    } else if (viewCount < prevViewCount && syncUnwatched) {
      console.log(`[watch-poll] "${title}" viewCount ${prevViewCount} -> ${viewCount}`)
      const body = mdType === "movie"
        ? { movies: [{ ids }] }
        : { episodes: [{ ids }] }
      await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
        headers: traktHeaders(user),
        timeout: 10_000,
      })
      console.log(`[watch-poll] "${title}" marked unwatched -> removed from Trakt history`)
      emit({
        type: "websocket_event",
        data: { subtype: "mark_unwatched", title },
        timestamp: Date.now(),
      })
    }
  } catch (err: any) {
    console.warn(`[watch-poll] Failed to sync "${title}": ${err.message}`)
  }
}

async function fetchRecentItems(serverUrl: string, token: string, sectionKey: string, type: "movie" | "episode"): Promise<any[]> {
  const base = serverUrl.replace(/\/$/, "")
  const typeNum = type === "episode" ? "4" : "1"
  const url = `${base}/library/sections/${sectionKey}/all?type=${typeNum}&sort=lastViewedAt:desc&X-Plex-Container-Size=10&X-Plex-Container-Start=0&includeGuids=1`
  const res = await axios.get(url, {
    headers: { "X-Plex-Token": token, Accept: "application/json" },
    timeout: 15_000,
  })
  return res.data?.MediaContainer?.Metadata || []
}

async function pollRecentChanges(serverUrl: string) {
  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })
  if (users.length === 0) return

  for (let user of users) {
    const token = user.plexAuthToken
    if (!token) continue

    try {
      const sectionsRes = await axios.get(`${serverUrl.replace(/\/$/, "")}/library/sections`, {
        headers: { "X-Plex-Token": token, Accept: "application/json" },
        timeout: 15_000,
      })
      const sections = sectionsRes.data?.MediaContainer?.Directory || []

      let changes = 0
      let checked = 0

      for (const section of sections) {
        const types: ("movie" | "episode")[] =
          section.type === "movie" ? ["movie"] :
          section.type === "show" ? ["episode"] : []

        for (const type of types) {
          const items = await fetchRecentItems(serverUrl, token, section.key, type)

          for (const item of items) {
            const rk = String(item.ratingKey)
            const viewCount = Number(item.viewCount) || 0
            const lastViewedAt = Number(item.lastViewedAt) || 0
            checked++

            const prev = stateCache.get(rk)
            stateCache.set(rk, { viewCount, lastViewedAt })

            if (!seeded || !prev) continue
            if (viewCount === prev.viewCount) continue

            changes++
            await syncItemToTrakt(user, rk, item, prev.viewCount)
          }
        }
      }

      lastPollAt = Date.now()

      if (!seeded) {
        seeded = true
        silentPollCount = 0
        totalCheckedSinceHeartbeat = 0
        console.log(`[watch-poll] Seeded cache with ${stateCache.size} recent items`)
      } else if (changes > 0) {
        silentPollCount = 0
        totalCheckedSinceHeartbeat = 0
        console.log(`[watch-poll] Checked ${checked} recent items, ${changes} changes synced`)
      } else {
        silentPollCount++
        totalCheckedSinceHeartbeat += checked
        if (silentPollCount >= HEARTBEAT_EVERY) {
          console.log(`[watch-poll] Alive — ${silentPollCount} polls, ${totalCheckedSinceHeartbeat} items checked, no changes`)
          silentPollCount = 0
          totalCheckedSinceHeartbeat = 0
        }
      }
    } catch (err: any) {
      console.warn(`[watch-poll] Poll failed for ${user.plexUsername || user.plexId}: ${err.message}`)
    }
  }
}

export async function startWatchStatePoller() {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  if (pollInterval <= 0) {
    console.log("[watch-poll] Poller disabled (WATCH_POLL_INTERVAL=0)")
    return
  }

  console.log(`[watch-poll] Smart poller running every ${pollInterval / 1000}s (top-10 recent items)`)

  try {
    await pollRecentChanges(serverUrl)
  } catch (err: any) {
    console.warn(`[watch-poll] Initial poll failed: ${err.message}`)
  }

  pollTimer = setInterval(async () => {
    try {
      await pollRecentChanges(serverUrl)
    } catch (err: any) {
      console.error(`[watch-poll] Error: ${err.message}`)
    }
  }, pollInterval)
}
