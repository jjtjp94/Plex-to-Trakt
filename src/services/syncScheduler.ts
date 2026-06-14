import cron from "node-cron"
import { runFullSync } from "./fullSync.js"

const INTERVAL_MAP: Record<string, string> = {
  "3h": "0 */3 * * *",
  "6h": "0 */6 * * *",
  "12h": "0 */12 * * *",
  "24h": "0 0 * * *",
}

const INTERVAL_MS: Record<string, number> = {
  "3h": 3 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
}

let lastSyncAt = 0
let nextSyncAt = 0
let currentTask: cron.ScheduledTask | null = null
let currentInterval: string | null = null

export function getSyncSchedulerState() {
  return {
    enabled: !!currentInterval,
    interval: currentInterval,
    lastSyncAt,
    nextSyncAt,
  }
}

export function markSyncRan() {
  lastSyncAt = Date.now()
  if (currentInterval && INTERVAL_MS[currentInterval]) {
    nextSyncAt = lastSyncAt + INTERVAL_MS[currentInterval]
  }
}

export function restartSyncScheduler() {
  if (currentTask) {
    currentTask.stop()
    currentTask = null
  }
  currentInterval = null
  nextSyncAt = 0
  startSyncScheduler()
}

export function startSyncScheduler() {
  const interval = process.env.SYNC_INTERVAL?.trim()

  if (!interval || interval === "off") {
    console.log("[sync] Full library sync disabled (SYNC_INTERVAL not set)")
    return
  }

  if (!process.env.PLEX_SERVER_URL) {
    console.log("[sync] SYNC_INTERVAL is set but PLEX_SERVER_URL is not — full sync disabled")
    return
  }

  const cronExpr = INTERVAL_MAP[interval]
  if (!cronExpr) {
    console.error(`[sync] Invalid SYNC_INTERVAL "${interval}". Use: 3h, 6h, 12h, 24h, or off`)
    return
  }

  currentInterval = interval

  currentTask = cron.schedule(cronExpr, () => {
    runFullSync()
      .then(() => markSyncRan())
      .catch((err) => console.error("[sync] Unhandled error:", err.message))
  })

  console.log(`[sync] Full library sync scheduled every ${interval}`)

  setTimeout(() => {
    console.log("[sync] Running initial sync...")
    runFullSync()
      .then(() => markSyncRan())
      .catch((err) => console.error("[sync] Initial sync failed:", err.message))
  }, 10_000)

  if (INTERVAL_MS[interval]) {
    nextSyncAt = Date.now() + 10_000 + INTERVAL_MS[interval]
  }
}
