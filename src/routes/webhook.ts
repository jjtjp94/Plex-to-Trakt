import express from "express"
import multer from "multer"
import { prisma } from "../services/prisma.js"
import { extractIds } from "../services/idParser.js"
import { syncToTrakt } from "../services/syncTrakt.js"
import { sendScrobble, computeProgress } from "../services/traktScrobble.js"
import {
  sessionKey,
  getSession,
  upsertSession,
  markPosted,
  markPlexScrobbled,
  markFinalized,
  extrapolatedProgress,
} from "../services/sessionTracker.js"
import { emit } from "../services/eventBus.js"

const PLAYBACK_EVENTS = ["media.play", "media.resume", "media.pause", "media.stop", "media.scrobble"]
const SUPPORTED_TYPES = ["movie", "episode"]

const router = express.Router()
const upload = multer()

// Test endpoint to verify webhook is reachable
router.get("/plex", (req, res) => {
  console.log("GET request to /webhooks/plex - webhook is reachable!")
  res.send("Webhook endpoint is working! Use POST to send webhook data.")
})

router.post("/plex", upload.single("thumb"), async (req, res) => {
  // Security: Only accept webhooks from Plex server IP
  if (process.env.PLEX_SERVER_IP) {
    // Use direct socket IP only (don't trust x-forwarded-for header as it can be spoofed)
    const clientIp = req.socket.remoteAddress
    const allowedIp = process.env.PLEX_SERVER_IP

    // Extract IP from potential IPv6 format (::ffff:192.168.1.1 -> 192.168.1.1)
    const normalizedIp = String(clientIp).replace(/^::ffff:/, "")

    if (normalizedIp !== allowedIp) {
      console.log("🚫 Webhook rejected from unauthorized IP:", normalizedIp)
      return res.status(403).send("forbidden")
    }
  }

  let payload

  try {
    // Plex sends form-encoded data with a 'payload' field
    if (req.body.payload) {
      payload = JSON.parse(req.body.payload)
    } else if (typeof req.body === "string") {
      payload = JSON.parse(req.body)
    } else {
      payload = req.body
    }
  } catch (e: any) {
    console.error("Failed to parse webhook:", e.message)
    return res.status(400).send("invalid body")
  }

  const { event, Metadata: md, Account } = payload

  if (!Account || !Account.id) {
    return res.status(200).send("no account")
  }

  const user = await prisma.user.findUnique({ where: { plexId: String(Account.id) } })

  if (!user) {
    console.log("Unknown user - Plex ID:", Account.id)
    return res.status(200).send("unknown user")
  }

  if (!PLAYBACK_EVENTS.includes(event)) {
    return res.status(200).send("ignored")
  }

  if (!md || !SUPPORTED_TYPES.includes(md.type)) {
    return res.status(200).send("unsupported type")
  }

  console.log(`📺 ${event}:`, md?.title, "for", user.plexUsername)

  // Pass the Guid array from metadata to help resolve plex:// format GUIDs
  const ids = extractIds(md.guid, md.Guid)
  if (!ids) {
    console.log("❌ Could not extract IDs from:", md?.guid)
    if (md.Guid && Array.isArray(md.Guid)) {
      console.log("   Available GUIDs:", md.Guid.map((g: any) => (typeof g === "string" ? g : g?.id)).join(", "))
    }
    return res.status(200).send("no ids")
  }

  const durationMs = Number(md.duration) || 0
  const key = sessionKey(String(Account.id), payload.Player?.uuid, String(md.ratingKey))
  const tracked = getSession(key)

  // viewOffset is in the payload on pause/resume/stop; on play and scrobble
  // it can be absent, so fall back to the tracked session's extrapolation
  let progress = computeProgress(md.viewOffset, durationMs)
  if (md.viewOffset == null && tracked) {
    progress = extrapolatedProgress(tracked)
  }

  try {
    switch (event) {
      case "media.play":
      case "media.resume": {
        // Plex sometimes fires play + resume back to back; one start is enough
        if (tracked && tracked.state === "playing" && Date.now() - tracked.lastPostAt < 5000) {
          return res.status(200).send("deduped")
        }
        await sendScrobble("start", user, md.type, ids, progress)
        const session = upsertSession({
          prismaUserId: user.id,
          plexAccountId: String(Account.id),
          playerUuid: payload.Player?.uuid,
          ratingKey: String(md.ratingKey),
          title: md.title,
          mdType: md.type,
          ids,
          durationMs,
          state: "playing",
          progress,
        })
        markPosted(session)
        emit({
          type: "scrobble",
          data: { action: "start", title: md.title, progress, user: user.plexUsername, player: payload.Player?.title, mediaType: md.type },
          timestamp: Date.now(),
        })
        console.log(`▶️ Trakt watching now at ${progress.toFixed(1)}%`)
        return res.status(200).send("ok")
      }

      case "media.pause": {
        await sendScrobble("pause", user, md.type, ids, progress)
        const session = upsertSession({
          prismaUserId: user.id,
          plexAccountId: String(Account.id),
          playerUuid: payload.Player?.uuid,
          ratingKey: String(md.ratingKey),
          title: md.title,
          mdType: md.type,
          ids,
          durationMs,
          state: "paused",
          progress,
        })
        markPosted(session)
        emit({
          type: "scrobble",
          data: { action: "pause", title: md.title, progress, user: user.plexUsername, player: payload.Player?.title, mediaType: md.type },
          timestamp: Date.now(),
        })
        console.log(`⏸ Trakt paused at ${progress.toFixed(1)}%`)
        return res.status(200).send("ok")
      }

      case "media.scrobble": {
        // Fires at 90% while playback continues. Don't stop the Trakt session
        // yet — that would clear "watching now" with 10% left. The tracker
        // arms a fallback in case media.stop never arrives.
        if (tracked && !tracked.finalized) {
          markPlexScrobbled(key)
          console.log("✓ 90% reached, will scrobble on stop")
          return res.status(200).send("deferred to stop")
        }
        // No live session (e.g. app restarted mid-playback) — record it now
        try {
          await sendScrobble("stop", user, md.type, ids, Math.max(progress, 90))
        } catch (err: any) {
          console.warn("⚠️ Scrobble failed, falling back to /sync/history:", err.message)
          await syncToTrakt(user, md, ids)
        }
        console.log("✅ Scrobbled to Trakt")
        return res.status(200).send("ok")
      }

      case "media.stop": {
        const watched = tracked?.plexScrobbled || progress >= 90
        const finalProgress = watched ? Math.max(progress, 90) : progress
        try {
          await sendScrobble("stop", user, md.type, ids, finalProgress)
        } catch (err: any) {
          if (!watched) throw err
          console.warn("⚠️ Scrobble failed, falling back to /sync/history:", err.message)
          await syncToTrakt(user, md, ids)
        }
        markFinalized(key)
        emit({
          type: watched ? "watched" : "scrobble",
          data: watched
            ? { title: md.title, mediaType: md.type, user: user.plexUsername }
            : { action: "stop", title: md.title, progress: finalProgress, user: user.plexUsername, player: payload.Player?.title, mediaType: md.type },
          timestamp: Date.now(),
        })
        console.log(`⏹ Stopped at ${finalProgress.toFixed(1)}%${watched ? " (recorded as watched)" : ""}`)
        return res.status(200).send("ok")
      }
    }

    return res.status(200).send("ignored")
  } catch (err: any) {
    console.error("❌ Error syncing to Trakt:", err.message)
    return res.status(500).send("error")
  }
})

export default router
