import axios from "axios"
import { emit } from "./eventBus.js"

const detectedSeasons = new Set<string>()
let pendingDetection: Promise<void> | null = null

interface PlexEpisodeMeta {
  ratingKey: string
  parentRatingKey: string
  index: number
  parentIndex: number
  title: string
  grandparentTitle: string
}

function plexHeaders(token: string) {
  return { "X-Plex-Token": token, Accept: "application/json" }
}

function baseUrl(serverUrl: string) {
  return serverUrl.replace(/\/$/, "")
}

async function getPlexPref(serverUrl: string, token: string, key: string): Promise<string | null> {
  const res = await axios.get(`${baseUrl(serverUrl)}/:/prefs`, {
    headers: plexHeaders(token),
    timeout: 10_000,
  })
  const settings = res.data?.MediaContainer?.Setting || []
  const pref = settings.find((s: any) => s.id === key)
  return pref?.value ?? null
}

async function setPlexPref(serverUrl: string, token: string, key: string, value: string): Promise<void> {
  await axios.put(`${baseUrl(serverUrl)}/:/prefs?${key}=${encodeURIComponent(value)}`, null, {
    headers: plexHeaders(token),
    timeout: 10_000,
  })
}

async function getEpisodeMeta(serverUrl: string, token: string, ratingKey: string): Promise<PlexEpisodeMeta | null> {
  const res = await axios.get(`${baseUrl(serverUrl)}/library/metadata/${ratingKey}`, {
    headers: plexHeaders(token),
    timeout: 10_000,
  })
  const md = res.data?.MediaContainer?.Metadata?.[0]
  if (!md || md.type !== "episode") return null
  return {
    ratingKey: String(md.ratingKey),
    parentRatingKey: String(md.parentRatingKey),
    index: Number(md.index),
    parentIndex: Number(md.parentIndex),
    title: md.title,
    grandparentTitle: md.grandparentTitle,
  }
}

async function getNextEpisode(serverUrl: string, token: string, seasonRatingKey: string, currentIndex: number): Promise<string | null> {
  const res = await axios.get(`${baseUrl(serverUrl)}/library/metadata/${seasonRatingKey}/children`, {
    headers: plexHeaders(token),
    timeout: 15_000,
  })
  const episodes = res.data?.MediaContainer?.Metadata || []
  const next = episodes.find((ep: any) => Number(ep.index) === currentIndex + 1)
  return next ? String(next.ratingKey) : null
}

async function hasMarkers(serverUrl: string, token: string, ratingKey: string): Promise<{ intro: boolean; credits: boolean }> {
  const res = await axios.get(`${baseUrl(serverUrl)}/library/metadata/${ratingKey}?includeMarkers=1`, {
    headers: plexHeaders(token),
    timeout: 10_000,
  })
  const md = res.data?.MediaContainer?.Metadata?.[0]
  const markers = md?.Marker || []
  return {
    intro: markers.some((m: any) => m.type === "intro"),
    credits: markers.some((m: any) => m.type === "credits"),
  }
}

async function triggerDetection(serverUrl: string, token: string, ratingKey: string, type: "intro" | "credits"): Promise<void> {
  await axios.put(
    `${baseUrl(serverUrl)}/library/metadata/${ratingKey}/${type}?force=1&manual=1`,
    null,
    { headers: plexHeaders(token), timeout: 10_000 }
  )
}

async function withPrefEnabled(
  serverUrl: string,
  token: string,
  prefKey: string,
  fn: () => Promise<void>
): Promise<void> {
  const current = await getPlexPref(serverUrl, token, prefKey)
  const needsToggle = current === "never"

  if (needsToggle) {
    await setPlexPref(serverUrl, token, prefKey, "scheduled")
  }

  try {
    await fn()
    // Give Plex time to read the pref before restoring it
    await new Promise((r) => setTimeout(r, 3000))
  } finally {
    if (needsToggle) {
      try {
        await setPlexPref(serverUrl, token, prefKey, "never")
      } catch (err: any) {
        console.error(`[intro] Failed to restore pref "${prefKey}" to "never": ${err.message}`)
      }
    }
  }
}

export async function handleEpisodePlay(ratingKey: string): Promise<void> {
  if (process.env.INTRO_DETECTION_ENABLED !== "true") return

  const serverUrl = process.env.PLEX_SERVER_URL
  const token = process.env.PLEX_TOKEN
  if (!serverUrl || !token) return

  if (pendingDetection) return
  pendingDetection = doDetection(serverUrl, token, ratingKey)
  try {
    await pendingDetection
  } finally {
    pendingDetection = null
  }
}

async function doDetection(serverUrl: string, token: string, ratingKey: string): Promise<void> {
  try {
    const meta = await getEpisodeMeta(serverUrl, token, ratingKey)
    if (!meta) return

    const seasonKey = `${meta.parentRatingKey}`

    const nextRatingKey = await getNextEpisode(serverUrl, token, meta.parentRatingKey, meta.index)
    if (!nextRatingKey) {
      console.log(`[intro] ${meta.grandparentTitle} S${meta.parentIndex}E${meta.index} is the last episode in season, skipping`)
      return
    }

    const existing = await hasMarkers(serverUrl, token, nextRatingKey)
    const needsIntro = !existing.intro && !detectedSeasons.has(`intro:${seasonKey}`)
    const needsCredits = !existing.credits

    if (!needsIntro && !needsCredits) {
      console.log(`[intro] Next episode already has markers, skipping`)
      return
    }

    console.log(`[intro] Triggering detection for next episode (S${meta.parentIndex}E${meta.index + 1})`)

    if (needsCredits) {
      await withPrefEnabled(serverUrl, token, "GenerateCreditsMarkerBehavior", async () => {
        await triggerDetection(serverUrl, token, nextRatingKey, "credits")
      })
      console.log(`[intro] Credit detection triggered for S${meta.parentIndex}E${meta.index + 1}`)
    }

    if (needsIntro) {
      await triggerDetection(serverUrl, token, nextRatingKey, "intro")
      detectedSeasons.add(`intro:${seasonKey}`)
      console.log(`[intro] Intro detection triggered for S${meta.parentIndex}E${meta.index + 1} (will scan full season)`)
    }

    emit({
      type: "websocket_event",
      data: {
        subtype: "intro_detection",
        title: `${meta.grandparentTitle} S${meta.parentIndex}E${meta.index + 1}`,
        intro: needsIntro,
        credits: needsCredits,
      },
      timestamp: Date.now(),
    })
  } catch (err: any) {
    console.error(`[intro] Detection failed:`, err.message)
  }
}
