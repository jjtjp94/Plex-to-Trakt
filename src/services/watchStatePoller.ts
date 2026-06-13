import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { getLibrarySections, getLibraryItems, extractAllIds, type PlexItem } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"

interface CachedState {
  viewCount: number
  viewOffset: number
  ids: Record<string, string | number>
  type: string
  title: string
}

const stateCache = new Map<string, Map<string, CachedState>>()

function cacheKey(userId: number) {
  return `user:${userId}`
}

function traktHeaders(user: any) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": user.traktClientId,
    Authorization: `Bearer ${user.traktAccessToken}`,
  }
}

function idKeys(ids: Record<string, any>): string[] {
  const keys: string[] = []
  if (ids.imdb) keys.push(`imdb:${ids.imdb}`)
  if (ids.tmdb) keys.push(`tmdb:${ids.tmdb}`)
  if (ids.tvdb) keys.push(`tvdb:${ids.tvdb}`)
  return keys
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

async function fetchItemMetadata(serverUrl: string, token: string, ratingKey: string): Promise<PlexItem | null> {
  try {
    const url = `${serverUrl.replace(/\/$/, "")}/library/metadata/${ratingKey}?includeGuids=1`
    const res = await axios.get(url, {
      headers: { "X-Plex-Token": token, Accept: "application/json" },
      timeout: 10_000,
    })
    const m = res.data?.MediaContainer?.Metadata?.[0]
    if (!m) return null
    const type = m.type === "movie" ? "movie" : m.type === "episode" ? "episode" : m.type
    return {
      ratingKey: String(m.ratingKey),
      title: m.title,
      type,
      viewCount: Number(m.viewCount) || 0,
      viewOffset: Number(m.viewOffset) || 0,
      duration: Number(m.duration) || 0,
      ids: extractAllIds(m.guid, m.Guid),
      parentIndex: m.parentIndex != null ? Number(m.parentIndex) : undefined,
      index: m.index != null ? Number(m.index) : undefined,
      grandparentRatingKey: m.grandparentRatingKey ? String(m.grandparentRatingKey) : undefined,
      grandparentTitle: m.grandparentTitle,
    }
  } catch {
    return null
  }
}

async function handleItemChange(ratingKey: string, serverUrl: string) {
  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })

  for (let user of users) {
    const userKey = cacheKey(user.id)
    const cache = stateCache.get(userKey)
    if (!cache) continue

    const prev = cache.get(ratingKey)
    if (!prev) continue

    const item = await fetchItemMetadata(serverUrl, user.plexAuthToken!, ratingKey)
    if (!item) continue

    cache.set(ratingKey, {
      viewCount: item.viewCount,
      viewOffset: item.viewOffset,
      ids: item.ids,
      type: item.type,
      title: item.title,
    })

    const watchChanged = item.viewCount !== prev.viewCount
    const progressCleared = prev.viewOffset > 0 && item.viewOffset === 0 && item.viewCount === 0

    if (!watchChanged && !progressCleared) continue

    const ids = item.ids
    if (Object.keys(ids).length === 0) continue

    const mdType = item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : null
    if (!mdType) continue

    const syncUnwatched = process.env.SYNC_UNWATCHED === "true"

    try {
      user = await refreshTraktToken(user)

      if (watchChanged && item.viewCount > prev.viewCount) {
        console.log(`[watch-poll] Change: "${item.title}" viewCount ${prev.viewCount} -> ${item.viewCount}`)
        const body = mdType === "movie"
          ? { movies: [{ ids, title: item.title }] }
          : { episodes: [{ ids, title: item.title }] }
        await axios.post(`${TRAKT_API}/sync/history`, body, {
          headers: traktHeaders(user),
          timeout: 10_000,
        })
        console.log(`[watch-poll] "${item.title}" marked watched -> synced to Trakt`)
      } else if (watchChanged && item.viewCount < prev.viewCount && syncUnwatched) {
        console.log(`[watch-poll] Change: "${item.title}" viewCount ${prev.viewCount} -> ${item.viewCount}`)
        const body = mdType === "movie"
          ? { movies: [{ ids }] }
          : { episodes: [{ ids }] }
        await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
          headers: traktHeaders(user),
          timeout: 10_000,
        })
        console.log(`[watch-poll] "${item.title}" marked unwatched -> removed from Trakt history`)
      }

      if (progressCleared) {
        console.log(`[watch-poll] Change: "${item.title}" viewOffset ${prev.viewOffset} -> 0 (progress cleared)`)
        await removeFromTraktPlayback(user, ids, item.title)
      }
    } catch (err: any) {
      console.warn(`[watch-poll] Failed to sync "${item.title}": ${err.message}`)
    }
  }
}

async function seedCache(serverUrl: string) {
  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })

  for (const user of users) {
    const token = user.plexAuthToken
    if (!token) continue

    const sections = await getLibrarySections(serverUrl, token)
    const items: PlexItem[] = []
    for (const section of sections) {
      if (section.type === "movie") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "movie"))
      } else if (section.type === "show") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "episode"))
      }
    }

    const cache = new Map<string, CachedState>()
    for (const item of items) {
      cache.set(item.ratingKey, {
        viewCount: item.viewCount,
        viewOffset: item.viewOffset,
        ids: item.ids,
        type: item.type,
        title: item.title,
      })
    }
    stateCache.set(cacheKey(user.id), cache)
    console.log(`[watch-poll] Seeded cache with ${items.length} items for ${user.plexUsername || user.plexId}`)
  }
}

// Debounce: Plex sends multiple notifications per action
const pendingItems = new Map<string, NodeJS.Timeout>()
const DEBOUNCE_MS = 2000

function debounceItemChange(ratingKey: string, serverUrl: string) {
  if (pendingItems.has(ratingKey)) {
    clearTimeout(pendingItems.get(ratingKey)!)
  }
  pendingItems.set(ratingKey, setTimeout(() => {
    pendingItems.delete(ratingKey)
    handleItemChange(ratingKey, serverUrl).catch((err) => {
      console.warn(`[watch-poll] Error handling change for ${ratingKey}: ${err.message}`)
    })
  }, DEBOUNCE_MS))
}

function connectWebSocket(serverUrl: string, token: string) {
  const wsUrl = `${serverUrl.replace(/^http/, "ws").replace(/\/$/, "")}/:/websockets/notifications?X-Plex-Token=${token}`

  const ws = new WebSocket(wsUrl)

  ws.addEventListener("open", () => {
    console.log("✓ Watch-state listener connected to Plex via WebSocket")
  })

  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data))
      const container = data.NotificationContainer
      if (!container) return

      // Log all event types so we can see what Plex actually sends
      console.log(`[watch-poll] WS event: type="${container.type}" size=${container.size || 0}`)
      if (container.type === "timeline") {
        const entries = container.TimelineEntry || []
        for (const entry of entries) {
          console.log(`[watch-poll]   timeline: itemID=${entry.itemID} type=${entry.type} state=${entry.state} identifier=${entry.identifier}`)
          if (entry.identifier !== "com.plexapp.plugins.library") continue
          if (!entry.itemID) continue
          debounceItemChange(String(entry.itemID), serverUrl)
        }
      } else if (container.type === "activity") {
        const activities = container.ActivityNotification || []
        for (const a of activities) {
          console.log(`[watch-poll]   activity: event="${a.event}" type=${a.Activity?.type} title="${a.Activity?.title}"`)
        }
      } else if (container.type === "playing") {
        const sessions = container.PlaySessionStateNotification || []
        for (const s of sessions) {
          console.log(`[watch-poll]   playing: ratingKey=${s.ratingKey} state="${s.state}" viewOffset=${s.viewOffset}`)
        }
      }
    } catch {
      // ignore malformed messages
    }
  })

  ws.addEventListener("close", () => {
    console.log("[watch-poll] WebSocket closed, reconnecting in 10s...")
    setTimeout(() => connectWebSocket(serverUrl, token), 10_000)
  })

  ws.addEventListener("error", () => {
    // close event will fire after this and handle reconnection
  })
}

export async function startWatchStatePoller() {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  const token = process.env.PLEX_TOKEN
  if (!token) {
    console.log("ℹ️  Watch-state listener disabled (PLEX_TOKEN not set)")
    return
  }

  try {
    await seedCache(serverUrl)
  } catch (err: any) {
    console.warn(`[watch-poll] Failed to seed cache: ${err.message}`)
  }

  connectWebSocket(serverUrl, token)
}
