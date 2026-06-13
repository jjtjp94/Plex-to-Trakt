import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { getLibrarySections, extractAllIds } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const RECENT_LIMIT = 50

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

const plexHeaders = (token: string) => ({
  "X-Plex-Token": token,
  Accept: "application/json",
})

async function getRecentItems(serverUrl: string, token: string, sectionKey: string, typeNum: string): Promise<any[]> {
  const base = serverUrl.replace(/\/$/, "")
  const url = `${base}/library/sections/${sectionKey}/all?type=${typeNum}&sort=lastViewedAt:desc&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=${RECENT_LIMIT}`
  const res = await axios.get(url, { headers: plexHeaders(token), timeout: 15_000 })
  return res.data?.MediaContainer?.Metadata || []
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

  const items: any[] = []
  for (const section of sections) {
    try {
      if (section.type === "movie") {
        items.push(...await getRecentItems(serverUrl, token, section.key, "1"))
      } else if (section.type === "show") {
        items.push(...await getRecentItems(serverUrl, token, section.key, "4"))
      }
    } catch {
      // skip this section
    }
  }

  const userCacheKey = cacheKey(user.id)
  if (!viewCountCache.has(userCacheKey)) {
    const cache = new Map<string, number>()
    for (const item of items) {
      cache.set(String(item.ratingKey), Number(item.viewCount) || 0)
    }
    viewCountCache.set(userCacheKey, cache)
    console.log(`[watch-poll] Seeded cache with ${items.length} items`)
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
        const body = mdType === "movie"
          ? { movies: [{ ids, title: item.title }] }
          : { episodes: [{ ids, title: item.title }] }
        await axios.post(`${TRAKT_API}/sync/history`, body, {
          headers: traktHeaders(user),
          timeout: 10_000,
        })
        console.log(`[watch-poll] "${item.title}" marked watched -> synced to Trakt`)
      } else if (currentCount < prevCount && syncUnwatched) {
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
