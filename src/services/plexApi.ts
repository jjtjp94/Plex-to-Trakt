import axios from "axios"

export interface PlexSection {
  key: string
  title: string
  type: string
}

export interface PlexItem {
  ratingKey: string
  title: string
  type: string
  viewCount: number
  ids: Record<string, string | number>
  parentIndex?: number
  index?: number
  grandparentRatingKey?: string
  grandparentTitle?: string
}

const plexHeaders = (token: string) => ({
  "X-Plex-Token": token,
  Accept: "application/json",
})

function baseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "")
}

export function extractAllIds(guid: string | undefined, guids: any[] | undefined): Record<string, string | number> {
  const ids: Record<string, string | number> = {}
  const tryExtract = (g: string) => {
    let m
    m = g.match(/(?:themoviedb|tmdb):\/\/(\d+)/i)
    if (m) ids.tmdb = Number(m[1])
    m = g.match(/imdb:\/\/(tt\d+)/i)
    if (m) ids.imdb = m[1]
    m = g.match(/(?:thetvdb|tvdb):\/\/(\d+)/i)
    if (m) ids.tvdb = Number(m[1])
    m = g.match(/com\.plexapp\.agents\.themoviedb:\/\/(\d+)/i)
    if (m) ids.tmdb = Number(m[1])
    m = g.match(/com\.plexapp\.agents\.imdb:\/\/(tt\d+)/i)
    if (m) ids.imdb = m[1]
    m = g.match(/com\.plexapp\.agents\.thetvdb:\/\/(\d+)/i)
    if (m) ids.tvdb = Number(m[1])
  }
  if (guid) tryExtract(guid)
  if (guids && Array.isArray(guids)) {
    for (const g of guids) {
      const id = typeof g === "string" ? g : g?.id
      if (id) tryExtract(id)
    }
  }
  return ids
}

export async function getLibrarySections(serverUrl: string, token: string): Promise<PlexSection[]> {
  const res = await axios.get(`${baseUrl(serverUrl)}/library/sections`, {
    headers: plexHeaders(token),
    timeout: 30_000,
  })
  const dirs = res.data?.MediaContainer?.Directory || []
  return dirs.map((d: any) => ({ key: d.key, title: d.title, type: d.type }))
}

export async function getLibraryItems(
  serverUrl: string,
  token: string,
  sectionKey: string,
  type: "movie" | "show" | "episode"
): Promise<PlexItem[]> {
  const typeNum = type === "episode" ? "4" : type === "show" ? "2" : "1"
  const url = `${baseUrl(serverUrl)}/library/sections/${sectionKey}/all?type=${typeNum}&includeGuids=1`
  const res = await axios.get(url, { headers: plexHeaders(token), timeout: 120_000 })
  const items = res.data?.MediaContainer?.Metadata || []
  return items.map((m: any) => ({
    ratingKey: String(m.ratingKey),
    title: m.title,
    type,
    viewCount: Number(m.viewCount) || 0,
    ids: extractAllIds(m.guid, m.Guid),
    parentIndex: m.parentIndex != null ? Number(m.parentIndex) : undefined,
    index: m.index != null ? Number(m.index) : undefined,
    grandparentRatingKey: m.grandparentRatingKey ? String(m.grandparentRatingKey) : undefined,
    grandparentTitle: m.grandparentTitle,
  }))
}

export async function markPlexWatched(serverUrl: string, token: string, ratingKey: string): Promise<void> {
  await axios.get(`${baseUrl(serverUrl)}/:/scrobble?identifier=com.plexapp.plugins.library&key=${ratingKey}`, {
    headers: plexHeaders(token),
    timeout: 10_000,
  })
}
