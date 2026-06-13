import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { extractAllIds } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"

// Cache: ratingKey -> last known viewCount, per user
const viewCountCache = new Map<string, Map<string, number>>()

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

async function pollUser(user: any, serverUrl: string) {
  const token = user.plexAuthToken
  if (!token) {
    console.log(`[watch-poll] User ${user.plexUsername || user.id} has no Plex token, skipping`)
    return
  }

  const url = `${serverUrl.replace(/\/$/, "")}/library/recentlyViewed?X-Plex-Token=${token}&includeGuids=1`
  let items: any[]
  try {
    const res = await axios.get(url, {
      headers: { Accept: "application/json" },
      timeout: 15_000,
    })
    items = res.data?.MediaContainer?.Metadata || []
  } catch (err: any) {
    console.warn(`[watch-poll] Plex unreachable: ${err.response?.status || err.message}`)
    return
  }

  const userCacheKey = cacheKey(user.id)
  if (!viewCountCache.has(userCacheKey)) {
    // First poll: seed cache, don't act
    const cache = new Map<string, number>()
    for (const item of items) {
      cache.set(String(item.ratingKey), Number(item.viewCount) || 0)
    }
    viewCountCache.set(userCacheKey, cache)
    console.log(`[watch-poll] Seeded cache with ${items.length} items from recentlyViewed`)
    return
  }

  const cache = viewCountCache.get(userCacheKey)!
  const syncUnwatched = process.env.SYNC_UNWATCHED === "true"

  let changes = 0
  for (const item of items) {
    const rk = String(item.ratingKey)
    const currentCount = Number(item.viewCount) || 0
    const prevCount = cache.get(rk)

    cache.set(rk, currentCount)

    if (prevCount === undefined) continue
    if (currentCount === prevCount) continue
    changes++
    console.log(`[watch-poll] Change detected: "${item.title}" viewCount ${prevCount} -> ${currentCount}`)

    const ids = extractAllIds(item.guid, item.Guid)
    if (Object.keys(ids).length === 0) continue

    const mdType = item.type === "movie" ? "movie" : item.type === "episode" ? "episode" : null
    if (!mdType) continue

    try {
      user = await refreshTraktToken(user)

      if (currentCount > prevCount) {
        // Newly watched
        const body = mdType === "movie"
          ? { movies: [{ ids, title: item.title }] }
          : { episodes: [{ ids, title: item.title }] }
        await axios.post(`${TRAKT_API}/sync/history`, body, {
          headers: traktHeaders(user),
          timeout: 10_000,
        })
        console.log(`[watch-poll] "${item.title}" marked watched -> synced to Trakt`)
      } else if (currentCount < prevCount && syncUnwatched) {
        // Newly unwatched
        const body = mdType === "movie"
          ? { movies: [{ ids }] }
          : { episodes: [{ ids }] }
        await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
          headers: traktHeaders(user),
          timeout: 10_000,
        })
        console.log(`[watch-poll] "${item.title}" marked unwatched -> removed from Trakt`)
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
