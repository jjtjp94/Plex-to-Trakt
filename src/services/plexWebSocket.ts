import WebSocket from "ws"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { emit } from "./eventBus.js"
import {
  getLibrarySections,
  getLibraryItems,
  markPlexWatched,
  type PlexItem,
} from "./plexApi.js"
import axios from "axios"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = parseInt(process.env.WS_RECONNECT_MAX_MS || "60000", 10)
const HEARTBEAT_INTERVAL_MS = 30_000

let ws: WebSocket | null = null
let reconnectDelay = RECONNECT_BASE_MS
let reconnectCount = 0
let heartbeatTimer: NodeJS.Timeout | null = null
let lastMessageAt = 0
let connectionState: "connected" | "reconnecting" | "disconnected" = "disconnected"

export function getWebSocketState() {
  return { connected: connectionState === "connected", state: connectionState, reconnectCount, lastMessageAt }
}

function emitStatus() {
  emit({
    type: "status",
    data: { websocket: connectionState },
    timestamp: Date.now(),
  })
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

function episodeKeys(showIds: Record<string, any>, season: number, episode: number): string[] {
  const keys: string[] = []
  if (showIds.imdb) keys.push(`imdb:${showIds.imdb}:s${season}e${episode}`)
  if (showIds.tmdb) keys.push(`tmdb:${showIds.tmdb}:s${season}e${episode}`)
  if (showIds.tvdb) keys.push(`tvdb:${showIds.tvdb}:s${season}e${episode}`)
  return keys
}

async function getToken(): Promise<string | undefined> {
  if (process.env.PLEX_TOKEN) return process.env.PLEX_TOKEN
  const user = await prisma.user.findFirst({ where: { plexAuthToken: { not: null } } })
  return user?.plexAuthToken || undefined
}

async function handleActivityNotification(notifications: any[]) {
  for (const notification of notifications) {
    const activity = notification.Activity
    if (!activity) continue

    const actType = activity.type
    if (actType !== "library.update" && actType !== "library.refresh.items") continue
    if (activity.progress !== 100 && activity.progress !== undefined) continue

    const sectionId = activity.Context?.librarySectionID
    if (!sectionId) continue

    console.log(`[ws] Library scan complete for section ${sectionId}, triggering targeted sync`)
    emit({
      type: "websocket_event",
      data: { subtype: "library_scan", sectionId },
      timestamp: Date.now(),
    })

    try {
      await syncLibrarySection(String(sectionId))
    } catch (err: any) {
      console.error(`[ws] Targeted sync failed for section ${sectionId}:`, err.message)
    }
  }
}

async function handleTimelineEntry(entries: any[]) {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  const token = await getToken()
  if (!token) return

  for (const entry of entries) {
    const { type, itemID, state, identifier } = entry
    if (identifier !== "com.plexapp.plugins.library") continue
    // type 1 = movie, 4 = episode
    if (type !== 1 && type !== 4) continue
    // state 5 = watched/unwatched change
    if (state !== 5) continue

    const ratingKey = String(itemID)
    const mdType = type === 1 ? "movie" : "episode"

    try {
      const res = await axios.get(`${serverUrl.replace(/\/$/, "")}/library/metadata/${ratingKey}?includeGuids=1`, {
        headers: { "X-Plex-Token": token, Accept: "application/json" },
        timeout: 10_000,
      })

      const md = res.data?.MediaContainer?.Metadata?.[0]
      if (!md) continue

      const viewCount = Number(md.viewCount) || 0
      const title = md.title || "Unknown"

      const ids: Record<string, any> = {}
      const guids = md.Guid || []
      for (const g of guids) {
        const gid = typeof g === "string" ? g : g?.id
        if (!gid) continue
        let m = gid.match(/(?:themoviedb|tmdb):\/\/(\d+)/i)
        if (m) ids.tmdb = Number(m[1])
        m = gid.match(/imdb:\/\/(tt\d+)/i)
        if (m) ids.imdb = m[1]
        m = gid.match(/(?:thetvdb|tvdb):\/\/(\d+)/i)
        if (m) ids.tvdb = Number(m[1])
      }

      if (Object.keys(ids).length === 0) continue

      const users = await prisma.user.findMany({
        where: { traktAccessToken: { not: null } },
      })

      for (let user of users) {
        user = await refreshTraktToken(user)
        const syncUnwatched = process.env.SYNC_UNWATCHED === "true"

        if (viewCount > 0) {
          const body = mdType === "movie"
            ? { movies: [{ ids, title }] }
            : { episodes: [{ ids, title }] }
          await axios.post(`${TRAKT_API}/sync/history`, body, {
            headers: traktHeaders(user),
            timeout: 10_000,
          })
          console.log(`[ws] "${title}" marked watched -> synced to Trakt`)
          emit({
            type: "websocket_event",
            data: { subtype: "mark_watched", title },
            timestamp: Date.now(),
          })
        } else if (syncUnwatched) {
          const body = mdType === "movie"
            ? { movies: [{ ids }] }
            : { episodes: [{ ids }] }
          await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
            headers: traktHeaders(user),
            timeout: 10_000,
          })
          console.log(`[ws] "${title}" marked unwatched -> removed from Trakt`)
          emit({
            type: "websocket_event",
            data: { subtype: "mark_unwatched", title },
            timestamp: Date.now(),
          })
        }
      }
    } catch (err: any) {
      console.error(`[ws] TimelineEntry sync failed for ratingKey ${ratingKey}:`, err.message)
    }
  }
}

export async function syncLibrarySection(sectionKey: string) {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) return

  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })
  if (users.length === 0) return

  for (let user of users) {
    try {
      user = await refreshTraktToken(user)
      const token = user.plexAuthToken!

      const sections = await getLibrarySections(serverUrl, token)
      const section = sections.find((s) => s.key === sectionKey)
      if (!section) continue

      if (section.type === "movie") {
        const movies = await getLibraryItems(serverUrl, token, sectionKey, "movie")
        const traktRes = await axios.get(`${TRAKT_API}/sync/watched/movies`, {
          headers: traktHeaders(user),
          timeout: 30_000,
        })
        const traktWatched: any[] = traktRes.data || []
        const traktKeys = new Set<string>()
        for (const tw of traktWatched) {
          for (const k of idKeys(tw.movie?.ids || {})) traktKeys.add(k)
        }

        // Trakt -> Plex: mark items watched in Plex that are watched on Trakt
        let synced = 0
        for (const movie of movies) {
          if (movie.viewCount > 0) continue
          const keys = idKeys(movie.ids)
          if (keys.length > 0 && keys.some((k) => traktKeys.has(k))) {
            try {
              await markPlexWatched(serverUrl, token, movie.ratingKey)
              synced++
            } catch (err: any) {
              console.warn(`[ws] Failed to mark "${movie.title}" watched: ${err.message}`)
            }
          }
        }

        // Plex -> Trakt: push newly watched Plex items to Trakt
        const toTrakt = movies.filter(
          (m) => m.viewCount > 0 && idKeys(m.ids).length > 0 && !idKeys(m.ids).some((k) => traktKeys.has(k))
        )
        if (toTrakt.length > 0) {
          await axios.post(`${TRAKT_API}/sync/history`, {
            movies: toTrakt.map((m) => ({ ids: m.ids, title: m.title })),
          }, { headers: traktHeaders(user), timeout: 30_000 })
        }

        if (synced > 0 || toTrakt.length > 0) {
          console.log(`[ws] Section "${section.title}": ${synced} Trakt->Plex, ${toTrakt.length} Plex->Trakt`)
        }
      } else if (section.type === "show") {
        const episodes = await getLibraryItems(serverUrl, token, sectionKey, "episode")
        const shows = await getLibraryItems(serverUrl, token, sectionKey, "show")

        const traktRes = await axios.get(`${TRAKT_API}/sync/watched/shows`, {
          headers: traktHeaders(user),
          timeout: 60_000,
        })
        const traktWatched: any[] = traktRes.data || []

        const showIdsByRK = new Map<string, Record<string, any>>()
        for (const show of shows) {
          if (Object.keys(show.ids).length > 0) showIdsByRK.set(show.ratingKey, show.ids)
        }

        const traktEpKeys = new Set<string>()
        for (const tw of traktWatched) {
          const showIds = tw.show?.ids || {}
          for (const season of tw.seasons || []) {
            for (const ep of season.episodes || []) {
              for (const k of episodeKeys(showIds, season.number, ep.number)) traktEpKeys.add(k)
            }
          }
        }

        // Trakt -> Plex
        const plexEpByComposite = new Map<string, PlexItem>()
        for (const ep of episodes) {
          if (ep.parentIndex == null || ep.index == null || !ep.grandparentRatingKey) continue
          const showIds = showIdsByRK.get(ep.grandparentRatingKey)
          if (!showIds) continue
          for (const k of episodeKeys(showIds, ep.parentIndex, ep.index)) plexEpByComposite.set(k, ep)
        }

        let synced = 0
        for (const tw of traktWatched) {
          const showIds = tw.show?.ids || {}
          for (const season of tw.seasons || []) {
            for (const ep of season.episodes || []) {
              const keys = episodeKeys(showIds, season.number, ep.number)
              const plexEp = keys.map((k) => plexEpByComposite.get(k)).find(Boolean)
              if (plexEp && plexEp.viewCount <= 0) {
                try {
                  await markPlexWatched(serverUrl, token, plexEp.ratingKey)
                  synced++
                } catch {}
              }
            }
          }
        }

        // Plex -> Trakt
        const toTrakt: PlexItem[] = []
        for (const ep of episodes) {
          if (ep.viewCount <= 0 || ep.parentIndex == null || ep.index == null) continue
          if (Object.keys(ep.ids).length === 0) continue
          const showIds = ep.grandparentRatingKey ? showIdsByRK.get(ep.grandparentRatingKey) : null
          if (!showIds) continue
          const keys = episodeKeys(showIds, ep.parentIndex, ep.index)
          if (keys.length > 0 && !keys.some((k) => traktEpKeys.has(k))) toTrakt.push(ep)
        }
        if (toTrakt.length > 0) {
          for (let i = 0; i < toTrakt.length; i += 500) {
            const chunk = toTrakt.slice(i, i + 500)
            await axios.post(`${TRAKT_API}/sync/history`, {
              episodes: chunk.map((e) => ({ ids: e.ids, title: e.title })),
            }, { headers: traktHeaders(user), timeout: 30_000 })
          }
        }

        if (synced > 0 || toTrakt.length > 0) {
          console.log(`[ws] Section "${section.title}": ${synced} Trakt->Plex, ${toTrakt.length} Plex->Trakt`)
        }
      }
    } catch (err: any) {
      console.error(`[ws] Targeted sync failed for user ${user.plexUsername}:`, err.message)
    }
  }
}

function connect(serverUrl: string, token: string) {
  const url = `${serverUrl.replace(/^http/, "ws").replace(/\/$/, "")}/:/websocket/notifications`
  const fullUrl = `${url}?X-Plex-Token=${token}`

  ws = new WebSocket(fullUrl)

  ws.on("open", () => {
    connectionState = "connected"
    reconnectDelay = RECONNECT_BASE_MS
    console.log("[ws] Connected to Plex WebSocket")
    emitStatus()
    startHeartbeat()
  })

  ws.on("message", (raw) => {
    lastMessageAt = Date.now()
    try {
      const msg = JSON.parse(raw.toString())
      const container = msg.NotificationContainer
      if (!container) return

      const { type } = container

      if (type === "playing" && container.PlaySessionStateNotification) {
        for (const n of container.PlaySessionStateNotification) {
          emit({
            type: "progress",
            data: {
              sessionKey: n.sessionKey,
              ratingKey: n.ratingKey,
              progress: n.viewOffset,
              state: n.state,
            },
            timestamp: Date.now(),
          })
        }
      } else if (type === "activity" && container.ActivityNotification) {
        handleActivityNotification(container.ActivityNotification).catch((e) =>
          console.error("[ws] Activity handler error:", e.message)
        )
      } else if (type === "timeline" && container.TimelineEntry) {
        handleTimelineEntry(container.TimelineEntry).catch((e) =>
          console.error("[ws] Timeline handler error:", e.message)
        )
      }
    } catch (err: any) {
      console.error("[ws] Failed to parse message:", err.message)
    }
  })

  ws.on("close", () => {
    stopHeartbeat()
    connectionState = "reconnecting"
    emitStatus()
    console.log(`[ws] Disconnected, reconnecting in ${reconnectDelay / 1000}s`)
    reconnectCount++
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
      connect(serverUrl, token)
    }, reconnectDelay)
  })

  ws.on("error", (err) => {
    console.error("[ws] WebSocket error:", err.message)
  })
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export async function startPlexWebSocket() {
  if (process.env.WS_ENABLED === "false") {
    console.log("[ws] WebSocket disabled (WS_ENABLED=false)")
    connectionState = "disconnected"
    return
  }

  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) {
    console.log("[ws] PLEX_SERVER_URL not set, WebSocket disabled")
    connectionState = "disconnected"
    return
  }

  const token = await getToken()
  if (!token) {
    console.log("[ws] No Plex token available, WebSocket disabled")
    connectionState = "disconnected"
    return
  }

  connectionState = "reconnecting"
  emitStatus()
  connect(serverUrl, token)
}
