import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { getLibrarySections, getLibraryItems, extractAllIds, type PlexItem } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedState {
  viewCount: number
  viewOffset: number
  ids: Record<string, string | number>
  type: string
  title: string
}

const stateCache = new Map<string, Map<string, CachedState>>()
let cachedSections: { key: string; type: string }[] | null = null

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

async function syncItemChange(user: any, item: PlexItem, prev: CachedState) {
  const watchChanged = item.viewCount !== prev.viewCount
  const progressCleared = prev.viewOffset > 0 && item.viewOffset === 0 && item.viewCount === 0

  if (!watchChanged && !progressCleared) return

  const ids = item.ids
  if (Object.keys(ids).length === 0) return

  const mdType = item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : null
  if (!mdType) return

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

async function pollAllItems(serverUrl: string) {
  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })
  if (users.length === 0) return

  for (let user of users) {
    const token = user.plexAuthToken
    if (!token) continue

    if (!cachedSections) {
      cachedSections = await getLibrarySections(serverUrl, token)
    }

    const items: PlexItem[] = []
    for (const section of cachedSections) {
      if (section.type === "movie") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "movie"))
      } else if (section.type === "show") {
        items.push(...await getLibraryItems(serverUrl, token, section.key, "episode"))
      }
    }

    const userKey = cacheKey(user.id)
    const cache = stateCache.get(userKey)

    if (!cache) {
      // First run: seed cache
      const newCache = new Map<string, CachedState>()
      for (const item of items) {
        newCache.set(item.ratingKey, {
          viewCount: item.viewCount,
          viewOffset: item.viewOffset,
          ids: item.ids,
          type: item.type,
          title: item.title,
        })
      }
      stateCache.set(userKey, newCache)
      console.log(`[watch-poll] Seeded cache with ${items.length} items for ${user.plexUsername || user.plexId}`)
      continue
    }

    let changes = 0
    for (const item of items) {
      const prev = cache.get(item.ratingKey)
      cache.set(item.ratingKey, {
        viewCount: item.viewCount,
        viewOffset: item.viewOffset,
        ids: item.ids,
        type: item.type,
        title: item.title,
      })

      if (!prev) continue
      if (item.viewCount === prev.viewCount && (item.viewOffset === prev.viewOffset || !(prev.viewOffset > 0 && item.viewOffset === 0 && item.viewCount === 0))) continue

      changes++
      await syncItemChange(user, item, prev)
    }

    if (changes === 0) console.log(`[watch-poll] Polled ${items.length} items, no changes`)
  }
}

export async function startWatchStatePoller() {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  console.log(`✓ Watch-state poller running every 5m`)

  // Seed cache immediately
  try {
    await pollAllItems(serverUrl)
  } catch (err: any) {
    console.warn(`[watch-poll] Initial poll failed: ${err.message}`)
  }

  setInterval(async () => {
    try {
      await pollAllItems(serverUrl)
    } catch (err: any) {
      console.error(`[watch-poll] Error: ${err.message}`)
    }
  }, POLL_INTERVAL_MS)
}
