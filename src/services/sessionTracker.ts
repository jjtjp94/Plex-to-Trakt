import axios from "axios"
import { prisma } from "./prisma.js"
import { sendScrobble, computeProgress } from "./traktScrobble.js"

/**
 * Tracks active playback sessions so Trakt's "watching now" status stays
 * accurate between Plex webhooks.
 *
 * Plex webhooks only fire on state transitions (play/pause/resume/stop) —
 * nothing fires on seek. Trakt extrapolates time remaining from the last
 * progress we sent, so after a seek the countdown drifts until the next
 * webhook. If PLEX_SERVER_URL is configured, a poller checks Plex's
 * /status/sessions while sessions are active and re-sends a corrected
 * scrobble when the observed position deviates from the expected one.
 */

const POLL_INTERVAL_MS = 15_000
const SEEK_THRESHOLD_MS = 30_000 // position drift that counts as a seek
const MIN_POST_GAP_MS = 5_000 // per-session floor between correction posts
const MAX_MISSED_POLLS = 2 // session gone from /status/sessions this many times -> finalize
const STALE_SESSION_MS = 8 * 60 * 60 * 1000 // sweep sessions idle this long

export interface TrackedSession {
  key: string
  prismaUserId: number
  plexAccountId: string
  playerUuid: string | null
  ratingKey: string
  title: string
  mdType: string
  ids: any
  durationMs: number
  state: "playing" | "paused"
  progress: number // percent at updatedAt
  updatedAt: number // epoch ms
  lastPostAt: number
  plexScrobbled: boolean // Plex fired media.scrobble (90% watched)
  finalized: boolean // scrobble/stop already sent to Trakt
  seenByPoller: boolean
  missedPolls: number
  fallbackTimer: NodeJS.Timeout | null
}

const sessions = new Map<string, TrackedSession>()
let pollTimer: NodeJS.Timeout | null = null
let sweepTimer: NodeJS.Timeout | null = null

export function sessionKey(plexAccountId: string, playerUuid: string | undefined, ratingKey: string): string {
  return `${plexAccountId}:${playerUuid || "unknown"}:${ratingKey}`
}

export function getSession(key: string): TrackedSession | undefined {
  return sessions.get(key)
}

export function getActiveSessionCount(): number {
  return sessions.size
}

export function getActiveSessions(): TrackedSession[] {
  return [...sessions.values()]
}

/** Progress we believe the session is at right now, extrapolated while playing. */
export function extrapolatedProgress(s: TrackedSession): number {
  if (s.state !== "playing" || s.durationMs <= 0) return s.progress
  const elapsedPct = ((Date.now() - s.updatedAt) / s.durationMs) * 100
  return Math.min(100, s.progress + elapsedPct)
}

export function upsertSession(input: {
  prismaUserId: number
  plexAccountId: string
  playerUuid: string | undefined
  ratingKey: string
  title: string
  mdType: string
  ids: any
  durationMs: number
  state: "playing" | "paused"
  progress: number
}): TrackedSession {
  const key = sessionKey(input.plexAccountId, input.playerUuid, input.ratingKey)
  const existing = sessions.get(key)
  const session: TrackedSession = {
    key,
    prismaUserId: input.prismaUserId,
    plexAccountId: input.plexAccountId,
    playerUuid: input.playerUuid || null,
    ratingKey: input.ratingKey,
    title: input.title,
    mdType: input.mdType,
    ids: input.ids,
    durationMs: input.durationMs,
    state: input.state,
    progress: input.progress,
    updatedAt: Date.now(),
    lastPostAt: existing?.lastPostAt ?? 0,
    plexScrobbled: existing?.plexScrobbled ?? false,
    finalized: existing?.finalized ?? false,
    seenByPoller: existing?.seenByPoller ?? false,
    missedPolls: 0,
    fallbackTimer: existing?.fallbackTimer ?? null,
  }
  sessions.set(key, session)
  ensureTimers()
  return session
}

export function markPosted(session: TrackedSession) {
  session.lastPostAt = Date.now()
}

/**
 * Plex fired media.scrobble (90%) but playback continues. Don't stop the
 * Trakt session yet — that would clear "watching now" early. Instead arm a
 * fallback so the watch still gets recorded if media.stop never arrives.
 */
export function markPlexScrobbled(key: string) {
  const session = sessions.get(key)
  if (!session || session.plexScrobbled) return
  session.plexScrobbled = true

  const remainingMs = Math.max(0, ((100 - extrapolatedProgress(session)) / 100) * session.durationMs)
  const delay = remainingMs + 5 * 60 * 1000
  session.fallbackTimer = setTimeout(() => finalizeSession(session, "fallback timer"), delay)
}

export function removeSession(key: string) {
  const session = sessions.get(key)
  if (session?.fallbackTimer) clearTimeout(session.fallbackTimer)
  sessions.delete(key)
  ensureTimers()
}

export function markFinalized(key: string) {
  const session = sessions.get(key)
  if (session) session.finalized = true
  removeSession(key)
}

/** Send a final scrobble for a session that ended without a media.stop webhook. */
async function finalizeSession(session: TrackedSession, reason: string) {
  if (session.finalized || !sessions.has(session.key)) return
  session.finalized = true

  const progress = extrapolatedProgress(session)
  // If Plex counted it watched, make sure Trakt does too (stop with >= 90%).
  // Otherwise just pause so the resume point is saved.
  const action = session.plexScrobbled ? "stop" : "pause"
  const finalProgress = session.plexScrobbled ? Math.max(progress, 90) : progress

  console.log(`⏹ Finalizing "${session.title}" via ${reason}: scrobble/${action} at ${finalProgress.toFixed(1)}%`)
  try {
    const user = await prisma.user.findUnique({ where: { id: session.prismaUserId } })
    if (user) await sendScrobble(action, user, session.mdType, session.ids, finalProgress)
  } catch (err: any) {
    console.error("❌ Failed to finalize session:", err.message)
  }
  removeSession(session.key)
}

function ensureTimers() {
  const wantPoller = sessions.size > 0 && !!process.env.PLEX_SERVER_URL
  if (wantPoller && !pollTimer) {
    pollTimer = setInterval(() => pollPlexSessions().catch((e) => console.error("Poll error:", e.message)), POLL_INTERVAL_MS)
  } else if (!wantPoller && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  if (sessions.size > 0 && !sweepTimer) {
    sweepTimer = setInterval(sweepStaleSessions, 10 * 60 * 1000)
  } else if (sessions.size === 0 && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

function sweepStaleSessions() {
  const now = Date.now()
  for (const session of sessions.values()) {
    if (now - session.updatedAt > STALE_SESSION_MS) {
      console.log(`🧹 Dropping stale session "${session.title}"`)
      removeSession(session.key)
    }
  }
}

/** Fetch live sessions from Plex and correct Trakt when positions drift (seeks). */
async function pollPlexSessions() {
  const serverUrl = process.env.PLEX_SERVER_URL
  if (!serverUrl || sessions.size === 0) return

  // Prefer a dedicated admin token; fall back to a tracked user's Plex token
  // (the server owner's token can see all sessions, shared users only their own)
  let token = process.env.PLEX_TOKEN
  if (!token) {
    const first = sessions.values().next().value
    if (first) {
      const user = await prisma.user.findUnique({ where: { id: first.prismaUserId } })
      token = user?.plexAuthToken || undefined
    }
  }
  if (!token) return

  const res = await axios.get(`${serverUrl.replace(/\/$/, "")}/status/sessions`, {
    headers: { "X-Plex-Token": token, Accept: "application/json" },
    timeout: 10_000,
  })

  const live: any[] = res.data?.MediaContainer?.Metadata || []

  for (const session of sessions.values()) {
    // Match on player UUID + ratingKey. /status/sessions reports the server
    // owner's User.id as "1" while webhooks use the global account id, so
    // account ids can't be compared across the two APIs.
    const match = live.find(
      (m) =>
        String(m.ratingKey) === session.ratingKey &&
        (!session.playerUuid || m.Player?.machineIdentifier === session.playerUuid)
    )

    if (!match) {
      // Only infer "session ended" if the poller could see it before —
      // a shared user's token may simply not have visibility
      if (session.seenByPoller && ++session.missedPolls >= MAX_MISSED_POLLS) {
        await finalizeSession(session, "session vanished from Plex")
      }
      continue
    }

    session.seenByPoller = true
    session.missedPolls = 0

    const observedState: "playing" | "paused" = match.Player?.state === "paused" ? "paused" : "playing"
    const observedMs = Number(match.viewOffset) || 0
    const expectedMs = (extrapolatedProgress(session) / 100) * session.durationMs
    const drifted = Math.abs(observedMs - expectedMs) > SEEK_THRESHOLD_MS
    const stateChanged = observedState !== session.state

    if (!drifted && !stateChanged) continue
    if (Date.now() - session.lastPostAt < MIN_POST_GAP_MS) continue

    const progress = computeProgress(observedMs, session.durationMs)
    const action = observedState === "playing" ? "start" : "pause"
    console.log(
      `🔁 Correcting "${session.title}": ${drifted ? "seek detected" : "state change"} -> scrobble/${action} at ${progress}%`
    )

    try {
      const user = await prisma.user.findUnique({ where: { id: session.prismaUserId } })
      if (!user) continue
      await sendScrobble(action, user, session.mdType, session.ids, progress)
      session.state = observedState
      session.progress = progress
      session.updatedAt = Date.now()
      markPosted(session)
    } catch (err: any) {
      console.error("❌ Failed to send correction to Trakt:", err.message)
    }
  }
}
