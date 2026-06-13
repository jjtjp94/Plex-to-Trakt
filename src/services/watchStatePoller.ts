import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { getLibrarySections, getLibraryItems, extractAllIds } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"

interface CachedState {
  viewCount: number
  viewOffset: number
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

async function pollUser(user: any, serverUrl: string) {
  const token = user.plexAuthToken
  if (!token) {
    console.log(`[watch-poll] User ${user.plexUsername || user.id} has no Plex token, skipping`)
    return
  }

  let sections
  try {
    sections = await getLibrarySections(serverUrl, token)
  } catch (err: any) {
    console.warn(`[watch-poll] Plex unreachable: ${err.response?.status || err.message}`)
    return
  }

  const items = []
  for (const section of sections) {
    try {
      if (section.type === "movie") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "movie"))
      } else if (section.type === "show") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "episode"))
      }
    } catch {
      // skip this section
    }
  }

  const userCacheKey = cacheKey(user.id)
  if (!stateCache.has(userCacheKey)) {
    const cache = new Map<string, CachedState>()
    for (const item of items) {
      cache.set(item.ratingKey, { viewCount: item.viewCount, viewOffset: item.viewOffset })
    }
    stateCache.set(userCacheKey, cache)
    console.log(`[watch-poll] Seeded cache with ${items.length} items`)
    return
  }

  const cache = stateCache.get(userCacheKey)!
  const syncUnwatched = process.env.SYNC_UNWATCHED === "true"

  let changes = 0
  for (const item of items) {
    const prev = cache.get(item.ratingKey)
    cache.set(item.ratingKey, { viewCount: item.viewCount, viewOffset: item.viewOffset })

    if (!prev) continue

    const watchChanged = item.viewCount !== prev.viewCount
    const progressCleared = prev.viewOffset > 0 && item.viewOffset === 0 && item.viewCount === 0

    if (!watchChanged && !progressCleared) continue
    changes++

    const ids = item.ids
    if (Object.keys(ids).length === 0) continue

    const mdType = item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : null
    if (!mdType) continue

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
  if (changes === 0) console.log(`[watch-poll] Polled ${items.length} items, no changes`)
}

let pollTimer: NodeJS.Timeout | null = null

export function startWatchStatePoller() {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  const interval = Number(process.env.WATCH_POLL_INTERVAL) || 0
  if (interval <= 0) {
    console.log("ℹ️  Watch-state poller disabled (WATCH_POLL_INTERVAL not set)")
    return
  }

  const intervalMs = Math.max(30_000, interval * 1000)
  console.log(`✓ Watch-state poller running every ${interval}s`)

  pollTimer = setInterval(async () => {
    try {
      const users = await prisma.user.findMany({
        where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
      })
      if (users.length === 0) {
        console.log("[watch-poll] No users with Plex+Trakt credentials, skipping")
        return
      }
      for (const user of users) {
        await pollUser(user, serverUrl)
      }
    } catch (err: any) {
      console.error("[watch-poll] Error:", err.message)
    }
  }, intervalMs)
}
