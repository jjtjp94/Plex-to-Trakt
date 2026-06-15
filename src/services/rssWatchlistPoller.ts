import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { emit } from "./eventBus.js"
import { traktHeaders, idKeys } from "./traktUtils.js"
import crypto from "crypto"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const DEFAULT_POLL_S = 0
const RSS_URL_PATTERN = /^https:\/\/rss\.plex\.tv\/[a-f0-9-]+$/

let pollTimer: NodeJS.Timeout | null = null
let pollIntervalMs = 0
let lastPollAt = 0
let lastItemCount = 0

interface RssItem {
  title: string
  guid: string
  category: string
  pubDate: string
  link: string
}

const knownGuids = new Map<number, Set<string>>()

export function getRssPollerState() {
  return {
    enabled: pollIntervalMs > 0,
    intervalMs: pollIntervalMs,
    lastPollAt,
    lastItemCount,
  }
}

export function parseRssPollInterval(): number {
  const raw = process.env.RSS_POLL_INTERVAL
  if (!raw || raw === "0") return 0
  const seconds = parseInt(raw, 10)
  if (isNaN(seconds) || seconds < 30 || seconds > 3600) return 0
  return seconds * 1000
}

export function restartRssPoller() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollIntervalMs = parseRssPollInterval()
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      pollAllUsers().catch((e) => console.error("[rss-wl] Poll error:", e.message))
    }, pollIntervalMs)
    console.log(`[rss-wl] Restarted with ${pollIntervalMs / 1000}s interval`)
  }
}

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET || ""
  return crypto.createHash("sha256").update(secret).digest()
}

export function encryptRssUrl(url: string): string {
  const key = encryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted.toString("hex")
}

export function decryptRssUrl(data: string): string {
  const parts = data.split(":")
  if (parts.length !== 3) throw new Error("Invalid encrypted data")
  const iv = Buffer.from(parts[0], "hex")
  const tag = Buffer.from(parts[1], "hex")
  const encrypted = Buffer.from(parts[2], "hex")
  const key = encryptionKey()
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted) + decipher.final("utf8")
}

export function maskRssUrl(url: string): string {
  const match = url.match(/^(https:\/\/rss\.plex\.tv\/)(.+)$/)
  if (!match) return "****"
  const id = match[2]
  return match[1] + "****" + id.slice(-3)
}

export function validateRssUrl(url: string): string | null {
  if (!RSS_URL_PATTERN.test(url)) {
    return "Must be a Plex watchlist RSS URL (https://rss.plex.tv/...)"
  }
  return null
}

function parseRssXml(xml: string): RssItem[] {
  const items: RssItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const get = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
      return m ? m[1].trim() : ""
    }
    const guidMatch = block.match(/<guid[^>]*>([^<]*)<\/guid>/)
    items.push({
      title: get("title"),
      guid: guidMatch ? guidMatch[1].trim() : "",
      category: get("category"),
      pubDate: get("pubDate"),
      link: get("link"),
    })
  }
  return items
}

function imdbFromGuid(guid: string): string | null {
  const m = guid.match(/^imdb:\/\/(tt\d+)$/)
  return m ? m[1] : null
}

async function fetchRssFeed(rssUrl: string): Promise<RssItem[]> {
  const res = await axios.get(rssUrl, {
    timeout: 15_000,
    maxRedirects: 3,
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    responseType: "text",
  })
  return parseRssXml(res.data)
}

async function syncWatchlistFromRss(user: any, items: RssItem[]) {
  const hdrs = traktHeaders(user)

  const [movieWl, showWl] = await Promise.all([
    axios.get(`${TRAKT_API}/sync/watchlist/movies`, { headers: hdrs, timeout: 30_000 }).then((r) => r.data || []).catch(() => []),
    axios.get(`${TRAKT_API}/sync/watchlist/shows`, { headers: hdrs, timeout: 30_000 }).then((r) => r.data || []).catch(() => []),
  ])

  const traktImdbIds = new Set<string>()
  for (const wl of movieWl) {
    const imdb = wl.movie?.ids?.imdb
    if (imdb) traktImdbIds.add(imdb)
  }
  for (const wl of showWl) {
    const imdb = wl.show?.ids?.imdb
    if (imdb) traktImdbIds.add(imdb)
  }

  const rssImdbIds = new Set<string>()
  const rssItemsByImdb = new Map<string, RssItem>()
  for (const item of items) {
    const imdb = imdbFromGuid(item.guid)
    if (imdb) {
      rssImdbIds.add(imdb)
      rssItemsByImdb.set(imdb, item)
    }
  }

  // RSS -> Trakt: add items from RSS not yet on Trakt watchlist
  const moviesToAdd: { ids: { imdb: string }; title: string }[] = []
  const showsToAdd: { ids: { imdb: string }; title: string }[] = []

  for (const [imdb, item] of rssItemsByImdb) {
    if (traktImdbIds.has(imdb)) continue
    const entry = { ids: { imdb }, title: item.title }
    if (item.category === "movie") {
      moviesToAdd.push(entry)
    } else {
      showsToAdd.push(entry)
    }
  }

  if (moviesToAdd.length > 0 || showsToAdd.length > 0) {
    const body: Record<string, any> = {}
    if (moviesToAdd.length > 0) body.movies = moviesToAdd
    if (showsToAdd.length > 0) body.shows = showsToAdd
    await axios.post(`${TRAKT_API}/sync/watchlist`, body, { headers: hdrs, timeout: 30_000 })
    const total = moviesToAdd.length + showsToAdd.length
    console.log(`[rss-wl] Added ${total} item(s) to Trakt watchlist (${moviesToAdd.length} movies, ${showsToAdd.length} shows)`)
    emit({
      type: "websocket_event",
      data: { subtype: "rss_watchlist_add", count: total },
      timestamp: Date.now(),
    })
  }

  // Trakt -> RSS: remove items from Trakt watchlist that are no longer in RSS
  const moviesToRemove: { ids: { imdb: string } }[] = []
  const showsToRemove: { ids: { imdb: string } }[] = []

  for (const wl of movieWl) {
    const imdb = wl.movie?.ids?.imdb
    if (imdb && !rssImdbIds.has(imdb)) {
      moviesToRemove.push({ ids: { imdb } })
    }
  }
  for (const wl of showWl) {
    const imdb = wl.show?.ids?.imdb
    if (imdb && !rssImdbIds.has(imdb)) {
      showsToRemove.push({ ids: { imdb } })
    }
  }

  if (moviesToRemove.length > 0 || showsToRemove.length > 0) {
    const body: Record<string, any> = {}
    if (moviesToRemove.length > 0) body.movies = moviesToRemove
    if (showsToRemove.length > 0) body.shows = showsToRemove
    await axios.post(`${TRAKT_API}/sync/watchlist/remove`, body, { headers: hdrs, timeout: 30_000 })
    const total = moviesToRemove.length + showsToRemove.length
    console.log(`[rss-wl] Removed ${total} item(s) from Trakt watchlist (${moviesToRemove.length} movies, ${showsToRemove.length} shows)`)
    emit({
      type: "websocket_event",
      data: { subtype: "rss_watchlist_remove", count: total },
      timestamp: Date.now(),
    })
  }

  const addTotal = moviesToAdd.length + showsToAdd.length
  const removeTotal = moviesToRemove.length + showsToRemove.length
  return { added: addTotal, removed: removeTotal }
}

async function pollUser(user: any) {
  if (!user.plexWatchlistRssUrl) return

  let rssUrl: string
  try {
    rssUrl = decryptRssUrl(user.plexWatchlistRssUrl)
  } catch {
    console.warn(`[rss-wl] Failed to decrypt RSS URL for ${user.plexUsername || user.plexId}`)
    return
  }

  const items = await fetchRssFeed(rssUrl)
  const currentGuids = new Set(items.map((i) => i.guid))

  const prevGuids = knownGuids.get(user.id)
  knownGuids.set(user.id, currentGuids)

  if (!prevGuids) {
    console.log(`[rss-wl] Seeded ${items.length} watchlist items for ${user.plexUsername || user.plexId}`)
    lastItemCount = items.length
    // First poll: do a full bidirectional sync to establish baseline
    try {
      const refreshed = await refreshTraktToken(user)
      await syncWatchlistFromRss(refreshed, items)
    } catch (err: any) {
      console.warn(`[rss-wl] Initial sync failed: ${err.message}`)
    }
    return
  }

  const added = [...currentGuids].filter((g) => !prevGuids.has(g))
  const removed = [...prevGuids].filter((g) => !currentGuids.has(g))
  lastItemCount = items.length

  if (added.length === 0 && removed.length === 0) return

  console.log(`[rss-wl] ${user.plexUsername || user.plexId}: ${added.length} added, ${removed.length} removed from Plex watchlist`)

  try {
    const refreshed = await refreshTraktToken(user)
    await syncWatchlistFromRss(refreshed, items)
  } catch (err: any) {
    console.warn(`[rss-wl] Watchlist sync failed for ${user.plexUsername || user.plexId}: ${err.message}`)
  }
}

async function pollAllUsers() {
  const users = await prisma.user.findMany({
    where: {
      traktAccessToken: { not: null },
      plexWatchlistRssUrl: { not: null },
    },
  })

  for (const user of users) {
    try {
      await pollUser(user)
    } catch (err: any) {
      console.warn(`[rss-wl] Error for ${user.plexUsername || user.plexId}: ${err.message}`)
    }
  }

  lastPollAt = Date.now()
}

export async function startRssWatchlistPoller() {
  pollIntervalMs = parseRssPollInterval()
  if (pollIntervalMs <= 0) {
    console.log("[rss-wl] RSS watchlist poller disabled (RSS_POLL_INTERVAL=0)")
    return
  }

  console.log(`[rss-wl] RSS watchlist poller running every ${pollIntervalMs / 1000}s`)

  try {
    await pollAllUsers()
  } catch (err: any) {
    console.warn(`[rss-wl] Initial poll failed: ${err.message}`)
  }

  pollTimer = setInterval(() => {
    pollAllUsers().catch((e) => console.error("[rss-wl] Poll error:", e.message))
  }, pollIntervalMs)
}
