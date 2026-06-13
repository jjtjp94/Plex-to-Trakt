import axios from "axios"
import { prisma } from "./prisma.js"
import { refreshTraktToken } from "./tokenRefresh.js"
import { getLibrarySections, getLibraryItems, markPlexWatched, markPlexUnwatched, type PlexItem } from "./plexApi.js"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"
const PLEX_MARK_DELAY_MS = 100
const SYNC_UNWATCHED = process.env.SYNC_UNWATCHED === "true"

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

async function syncMovies(user: any, plexMovies: PlexItem[], serverUrl: string) {
  const traktRes = await axios.get(`${TRAKT_API}/sync/watched/movies`, {
    headers: traktHeaders(user),
    timeout: 30_000,
  })
  const traktWatched: any[] = traktRes.data || []

  const traktKeys = new Set<string>()
  for (const tw of traktWatched) {
    for (const k of idKeys(tw.movie?.ids || {})) traktKeys.add(k)
  }

  const plexByKey = new Map<string, PlexItem>()
  let noIdMovies = 0
  for (const pm of plexMovies) {
    const keys = idKeys(pm.ids)
    if (keys.length === 0 && pm.viewCount > 0) {
      noIdMovies++
      console.log(`[sync]   ⚠ No external IDs for watched movie: "${pm.title}" (ratingKey=${pm.ratingKey})`)
    }
    for (const k of keys) plexByKey.set(k, pm)
  }
  if (noIdMovies > 0) console.log(`[sync]   ${noIdMovies} watched movie(s) skipped — no tmdb/imdb/tvdb IDs in Plex`)

  const watchedInPlex = plexMovies.filter((m) => m.viewCount > 0)
  console.log(`[sync]   Plex: ${watchedInPlex.length} watched, ${plexMovies.length} total | Trakt: ${traktWatched.length} watched`)

  // Plex -> Trakt
  const toTrakt = plexMovies.filter(
    (m) => m.viewCount > 0 && idKeys(m.ids).length > 0 && !idKeys(m.ids).some((k) => traktKeys.has(k))
  )
  if (toTrakt.length > 0) {
    console.log(`[sync]   ${toTrakt.length} movie(s) Plex -> Trakt`)
    const body = { movies: toTrakt.map((m) => ({ ids: m.ids, title: m.title })) }
    const res = await axios.post(`${TRAKT_API}/sync/history`, body, {
      headers: traktHeaders(user),
      timeout: 30_000,
    })
    const nf = res.data?.not_found?.movies?.length || 0
    if (nf) console.log(`[sync]   ${nf} movie(s) not found on Trakt`)
  }

  // Trakt -> Plex
  let toPlex = 0
  let notInPlexLibrary = 0
  for (const tw of traktWatched) {
    const keys = idKeys(tw.movie?.ids || {})
    const plexItem = keys.map((k) => plexByKey.get(k)).find(Boolean)
    if (!plexItem) {
      notInPlexLibrary++
      console.log(`[sync]   ⚠ Trakt watched "${tw.movie?.title}" not found in Plex library (ids: ${JSON.stringify(tw.movie?.ids)})`)
      continue
    }
    if (plexItem.viewCount <= 0) {
      try {
        await markPlexWatched(serverUrl, user.plexAuthToken, plexItem.ratingKey)
        toPlex++
        await new Promise((r) => setTimeout(r, PLEX_MARK_DELAY_MS))
      } catch (err: any) {
        console.warn(`[sync]   Failed to mark "${plexItem.title}" watched in Plex: ${err.message}`)
      }
    }
  }
  if (toPlex > 0) console.log(`[sync]   ${toPlex} movie(s) Trakt -> Plex`)
  if (notInPlexLibrary > 0) console.log(`[sync]   ${notInPlexLibrary} Trakt movie(s) not in Plex library (skipped)`)

  // Unwatched sync (opt-in): unwatched in Plex -> remove from Trakt
  let removedFromTrakt = 0
  if (SYNC_UNWATCHED) {
    const toRemove = plexMovies.filter(
      (m) => m.viewCount <= 0 && idKeys(m.ids).length > 0 && idKeys(m.ids).some((k) => traktKeys.has(k))
    )
    if (toRemove.length > 0) {
      console.log(`[sync]   ${toRemove.length} unwatched movie(s) Plex -> removing from Trakt`)
      const body = { movies: toRemove.map((m) => ({ ids: m.ids })) }
      await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
        headers: traktHeaders(user),
        timeout: 30_000,
      })
      removedFromTrakt = toRemove.length
    }

    // Unwatched in Trakt -> unmark in Plex
    let unmarkedInPlex = 0
    for (const pm of plexMovies) {
      if (pm.viewCount <= 0) continue
      const keys = idKeys(pm.ids)
      if (keys.length > 0 && !keys.some((k) => traktKeys.has(k))) {
        // This item is watched in Plex but NOT in Trakt.
        // But we already handled Plex->Trakt above, so this could be
        // a newly-removed item from Trakt. Only unmark if we didn't
        // just sync it TO Trakt in this same run.
        const justSynced = toTrakt.some((t) => t.ratingKey === pm.ratingKey)
        if (justSynced) continue
        try {
          await markPlexUnwatched(serverUrl, user.plexAuthToken, pm.ratingKey)
          unmarkedInPlex++
          await new Promise((r) => setTimeout(r, PLEX_MARK_DELAY_MS))
        } catch (err: any) {
          console.warn(`[sync]   Failed to unmark "${pm.title}" in Plex: ${err.message}`)
        }
      }
    }
    if (unmarkedInPlex > 0) console.log(`[sync]   ${unmarkedInPlex} movie(s) unmarked in Plex`)
  }

  return { toTrakt: toTrakt.length, toPlex }
}

async function syncEpisodes(user: any, plexShows: PlexItem[], plexEpisodes: PlexItem[], serverUrl: string) {
  const traktRes = await axios.get(`${TRAKT_API}/sync/watched/shows`, {
    headers: traktHeaders(user),
    timeout: 60_000,
  })
  const traktWatched: any[] = traktRes.data || []

  // Map: Plex show ratingKey -> show external IDs
  const showIdsByRK = new Map<string, Record<string, any>>()
  const plexShowByTitle = new Map<string, PlexItem>()
  let showsWithoutIds = 0
  for (const show of plexShows) {
    plexShowByTitle.set(show.title.toLowerCase(), show)
    if (Object.keys(show.ids).length > 0) {
      showIdsByRK.set(show.ratingKey, show.ids)
    } else {
      showsWithoutIds++
      console.log(`[sync]   ⚠ No external IDs for show: "${show.title}" (ratingKey=${show.ratingKey})`)
    }
  }
  if (showsWithoutIds > 0) console.log(`[sync]   ${showsWithoutIds} show(s) have no IDs — their episodes will be skipped`)

  // Build Trakt watched episode set with composite keys
  const traktEpKeys = new Set<string>()
  for (const tw of traktWatched) {
    const showIds = tw.show?.ids || {}
    for (const season of tw.seasons || []) {
      for (const ep of season.episodes || []) {
        for (const k of episodeKeys(showIds, season.number, ep.number)) traktEpKeys.add(k)
      }
    }
  }

  // Index Plex episodes by composite key (showId:s#e#) for Trakt -> Plex lookup
  const plexEpByComposite = new Map<string, PlexItem>()
  for (const ep of plexEpisodes) {
    if (ep.parentIndex == null || ep.index == null || !ep.grandparentRatingKey) continue
    const showIds = showIdsByRK.get(ep.grandparentRatingKey)
    if (!showIds) continue
    for (const k of episodeKeys(showIds, ep.parentIndex, ep.index)) plexEpByComposite.set(k, ep)
  }

  // Plex -> Trakt
  const watchedEps = plexEpisodes.filter((e) => e.viewCount > 0)
  let noShowIds = 0
  let noEpIds = 0
  console.log(`[sync]   Plex: ${watchedEps.length} watched episodes, ${plexEpisodes.length} total | Trakt: ${traktEpKeys.size} episode keys`)
  const toTrakt: PlexItem[] = []
  for (const ep of plexEpisodes) {
    if (ep.viewCount <= 0 || ep.parentIndex == null || ep.index == null) continue
    if (Object.keys(ep.ids).length === 0) {
      noEpIds++
      continue
    }
    const showIds = ep.grandparentRatingKey ? showIdsByRK.get(ep.grandparentRatingKey) : null
    if (!showIds) {
      noShowIds++
      console.log(`[sync]   ⚠ Watched ep "${ep.grandparentTitle || '?'}" S${ep.parentIndex}E${ep.index} "${ep.title}" — parent show has no IDs`)
      continue
    }
    const keys = episodeKeys(showIds, ep.parentIndex, ep.index)
    if (keys.length > 0 && !keys.some((k) => traktEpKeys.has(k))) toTrakt.push(ep)
  }
  if (noEpIds > 0) console.log(`[sync]   ${noEpIds} watched episode(s) skipped — no episode-level IDs`)
  if (noShowIds > 0) console.log(`[sync]   ${noShowIds} watched episode(s) skipped — parent show has no IDs`)
  if (toTrakt.length > 0) {
    console.log(`[sync]   ${toTrakt.length} episode(s) Plex -> Trakt`)
    for (let i = 0; i < toTrakt.length; i += 500) {
      const chunk = toTrakt.slice(i, i + 500)
      const body = { episodes: chunk.map((e) => ({ ids: e.ids, title: e.title })) }
      await axios.post(`${TRAKT_API}/sync/history`, body, {
        headers: traktHeaders(user),
        timeout: 30_000,
      })
    }
  }

  // Trakt -> Plex
  let toPlex = 0
  const missedByShow = new Map<string, { count: number; traktIds: any; plexIds?: any }>()
  for (const tw of traktWatched) {
    const showIds = tw.show?.ids || {}
    const showTitle = tw.show?.title || "?"
    for (const season of tw.seasons || []) {
      for (const ep of season.episodes || []) {
        const keys = episodeKeys(showIds, season.number, ep.number)
        const plexEp = keys.map((k) => plexEpByComposite.get(k)).find(Boolean)
        if (!plexEp) {
          if (!missedByShow.has(showTitle)) {
            const plexMatch = plexShowByTitle.get(showTitle.toLowerCase())
            missedByShow.set(showTitle, {
              count: 0,
              traktIds: showIds,
              plexIds: plexMatch ? plexMatch.ids : undefined,
            })
          }
          missedByShow.get(showTitle)!.count++
          continue
        }
        if (plexEp.viewCount <= 0) {
          try {
            await markPlexWatched(serverUrl, user.plexAuthToken, plexEp.ratingKey)
            toPlex++
            await new Promise((r) => setTimeout(r, PLEX_MARK_DELAY_MS))
          } catch (err: any) {
            console.warn(`[sync]   Failed to mark "${plexEp.title}" watched in Plex: ${err.message}`)
          }
        }
      }
    }
  }
  if (toPlex > 0) console.log(`[sync]   ${toPlex} episode(s) Trakt -> Plex`)
  if (missedByShow.size > 0) {
    let totalMissed = 0
    for (const [title, info] of missedByShow) {
      totalMissed += info.count
      if (info.plexIds) {
        console.log(`[sync]   ⚠ ID MISMATCH "${title}" (${info.count} eps) — Trakt IDs: ${JSON.stringify(info.traktIds)} vs Plex IDs: ${JSON.stringify(info.plexIds)}`)
      } else {
        console.log(`[sync]   ⚠ "${title}" (${info.count} eps) — not in Plex library`)
      }
    }
    console.log(`[sync]   ${totalMissed} Trakt episode(s) across ${missedByShow.size} show(s) could not be matched`)
  }

  // Unwatched sync for episodes (opt-in)
  if (SYNC_UNWATCHED) {
    // Unwatched in Plex -> remove from Trakt
    const toRemove: PlexItem[] = []
    for (const ep of plexEpisodes) {
      if (ep.viewCount > 0 || ep.parentIndex == null || ep.index == null) continue
      if (Object.keys(ep.ids).length === 0) continue
      const showIds = ep.grandparentRatingKey ? showIdsByRK.get(ep.grandparentRatingKey) : null
      if (!showIds) continue
      const keys = episodeKeys(showIds, ep.parentIndex, ep.index)
      if (keys.length > 0 && keys.some((k) => traktEpKeys.has(k))) toRemove.push(ep)
    }
    if (toRemove.length > 0) {
      console.log(`[sync]   ${toRemove.length} unwatched episode(s) Plex -> removing from Trakt`)
      for (let i = 0; i < toRemove.length; i += 500) {
        const chunk = toRemove.slice(i, i + 500)
        const body = { episodes: chunk.map((e) => ({ ids: e.ids })) }
        await axios.post(`${TRAKT_API}/sync/history/remove`, body, {
          headers: traktHeaders(user),
          timeout: 30_000,
        })
      }
    }

    // Unwatched in Trakt -> unmark in Plex
    let unmarkedInPlex = 0
    for (const ep of plexEpisodes) {
      if (ep.viewCount <= 0 || ep.parentIndex == null || ep.index == null) continue
      const showIds = ep.grandparentRatingKey ? showIdsByRK.get(ep.grandparentRatingKey) : null
      if (!showIds) continue
      const keys = episodeKeys(showIds, ep.parentIndex, ep.index)
      if (keys.length === 0) continue
      const inTrakt = keys.some((k) => traktEpKeys.has(k))
      if (inTrakt) continue
      const justSynced = toTrakt.some((t) => t.ratingKey === ep.ratingKey)
      if (justSynced) continue
      try {
        await markPlexUnwatched(serverUrl, user.plexAuthToken, ep.ratingKey)
        unmarkedInPlex++
        await new Promise((r) => setTimeout(r, PLEX_MARK_DELAY_MS))
      } catch (err: any) {
        console.warn(`[sync]   Failed to unmark "${ep.title}" in Plex: ${err.message}`)
      }
    }
    if (unmarkedInPlex > 0) console.log(`[sync]   ${unmarkedInPlex} episode(s) unmarked in Plex`)
  }

  return { toTrakt: toTrakt.length, toPlex }
}

export async function runFullSync(): Promise<void> {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl) {
    console.log("[sync] PLEX_SERVER_URL not set, skipping full sync")
    return
  }

  const users = await prisma.user.findMany({
    where: { traktAccessToken: { not: null }, plexAuthToken: { not: null } },
  })
  if (users.length === 0) {
    console.log("[sync] No users with both Plex and Trakt credentials, skipping")
    return
  }

  console.log(`[sync] Starting full sync for ${users.length} user(s)`)
  const start = Date.now()

  for (const rawUser of users) {
    let user = rawUser
    try {
      user = await refreshTraktToken(user)
      console.log(`[sync] Syncing ${user.plexUsername || user.plexId}...`)

      const sections = await getLibrarySections(serverUrl, user.plexAuthToken!)
      let totalToTrakt = 0
      let totalToPlex = 0

      for (const section of sections.filter((s) => s.type === "movie")) {
        console.log(`[sync]   Library: ${section.title} (movies)`)
        const movies = await getLibraryItems(serverUrl, user.plexAuthToken!, section.key, "movie")
        const r = await syncMovies(user, movies, serverUrl)
        totalToTrakt += r.toTrakt
        totalToPlex += r.toPlex
      }

      for (const section of sections.filter((s) => s.type === "show")) {
        console.log(`[sync]   Library: ${section.title} (shows)`)
        const shows = await getLibraryItems(serverUrl, user.plexAuthToken!, section.key, "show")
        const episodes = await getLibraryItems(serverUrl, user.plexAuthToken!, section.key, "episode")
        const r = await syncEpisodes(user, shows, episodes, serverUrl)
        totalToTrakt += r.toTrakt
        totalToPlex += r.toPlex
      }

      if (totalToTrakt === 0 && totalToPlex === 0) {
        console.log(`[sync] ${user.plexUsername}: already in sync`)
      } else {
        console.log(`[sync] ${user.plexUsername}: synced ${totalToTrakt} -> Trakt, ${totalToPlex} -> Plex`)
      }
    } catch (err: any) {
      console.error(`[sync] Error syncing ${user.plexUsername || user.plexId}: ${err.message}`)
    }
  }

  console.log(`[sync] Full sync complete in ${((Date.now() - start) / 1000).toFixed(1)}s`)
}
