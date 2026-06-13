import axios from "axios"
import { refreshTraktToken } from "./tokenRefresh.js"

export type ScrobbleAction = "start" | "pause" | "stop"

const TRAKT_API = process.env.TRAKT_API_URL || "https://api.trakt.tv"

/**
 * Compute watch progress percentage from Plex metadata.
 * viewOffset and duration are both in milliseconds.
 */
export function computeProgress(viewOffsetMs: number | undefined, durationMs: number | undefined): number {
  if (!viewOffsetMs || !durationMs || durationMs <= 0) return 0
  const pct = (viewOffsetMs / durationMs) * 100
  return Math.min(100, Math.max(0, Math.round(pct * 100) / 100))
}

/**
 * Build the movie/episode portion of a Trakt scrobble body.
 * The idParser returns either episode-level ids ({ tmdb } / { imdb } / { tvdb })
 * or legacy show-level ids with season/episode ({ tvdb, season, episode }).
 */
function buildItem(mdType: string, ids: any) {
  if (mdType === "movie") {
    return { movie: { ids } }
  }
  if (mdType === "episode") {
    const { season, episode, ...rest } = ids
    if (season != null && episode != null) {
      return { show: { ids: rest }, episode: { season, number: episode } }
    }
    return { episode: { ids } }
  }
  return null
}

/**
 * Send a scrobble start/pause/stop to Trakt.
 *
 * Trakt semantics:
 * - start: marks the user as "watching now"; Trakt extrapolates time
 *   remaining from progress, so the countdown ticks live on their end
 * - pause: saves resumable playback progress
 * - stop: progress >= 80% records a watched play, below that it's
 *   treated as a pause
 *
 * Returns true if Trakt accepted the call (a duplicate-scrobble 409
 * counts as accepted — the play is already recorded).
 */
export async function sendScrobble(
  action: ScrobbleAction,
  user: any,
  mdType: string,
  ids: any,
  progress: number
): Promise<boolean> {
  const item = buildItem(mdType, ids)
  if (!item) return false // unsupported type

  user = await refreshTraktToken(user)

  const body = { ...item, progress }

  try {
    await axios.post(`${TRAKT_API}/scrobble/${action}`, body, {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": user.traktClientId,
        Authorization: `Bearer ${user.traktAccessToken}`,
      },
    })
    return true
  } catch (err: any) {
    // 409 on stop = Trakt already recorded this play within the last hour
    if (action === "stop" && err.response?.status === 409) {
      console.log("ℹ️ Trakt already scrobbled this item (409), treating as success")
      return true
    }
    // 422 = Trakt rejected the scrobble (progress went backward after a
    // seek, or the item was already counted as watched). Non-fatal.
    if (err.response?.status === 422) {
      console.warn(`⚠️ Trakt rejected scrobble/${action} (422) — likely progress went backward or item already watched`)
      return false
    }
    // 429 = rate limited; corrections are best-effort, so just log it
    if (err.response?.status === 429) {
      console.warn("⚠️ Trakt rate limit hit (429), Retry-After:", err.response.headers["retry-after"])
      return false
    }
    throw err
  }
}
