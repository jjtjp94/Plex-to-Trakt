export function traktHeaders(user: { traktClientId: string; traktAccessToken: string }) {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": user.traktClientId,
    Authorization: `Bearer ${user.traktAccessToken}`,
  }
}

export function idKeys(ids: Record<string, any>): string[] {
  const keys: string[] = []
  if (ids.imdb) keys.push(`imdb:${ids.imdb}`)
  if (ids.tmdb) keys.push(`tmdb:${ids.tmdb}`)
  if (ids.tvdb) keys.push(`tvdb:${ids.tvdb}`)
  return keys
}

export function episodeKeys(showIds: Record<string, any>, season: number, episode: number): string[] {
  const keys: string[] = []
  if (showIds.imdb) keys.push(`imdb:${showIds.imdb}:s${season}e${episode}`)
  if (showIds.tmdb) keys.push(`tmdb:${showIds.tmdb}:s${season}e${episode}`)
  if (showIds.tvdb) keys.push(`tvdb:${showIds.tvdb}:s${season}e${episode}`)
  return keys
}
