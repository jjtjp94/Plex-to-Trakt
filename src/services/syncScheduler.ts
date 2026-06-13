import cron from "node-cron"
import { runFullSync } from "./fullSync.js"

const INTERVAL_MAP: Record<string, string> = {
  "3h": "0 */3 * * *",
  "6h": "0 */6 * * *",
  "12h": "0 */12 * * *",
  "24h": "0 0 * * *",
}

export function startSyncScheduler() {
  const interval = process.env.SYNC_INTERVAL?.trim()

  if (!interval || interval === "off") {
    console.log("ℹ️  Full library sync disabled (SYNC_INTERVAL not set)")
    return
  }

  if (!process.env.PLEX_SERVER_URL) {
    console.log("⚠️  SYNC_INTERVAL is set but PLEX_SERVER_URL is not — full sync disabled")
    return
  }

  const cronExpr = INTERVAL_MAP[interval]
  if (!cronExpr) {
    console.error(`❌ Invalid SYNC_INTERVAL "${interval}". Use: 3h, 6h, 12h, 24h, or off`)
    return
  }

  cron.schedule(cronExpr, () => {
    runFullSync().catch((err) => console.error("[sync] Unhandled error:", err.message))
  })

  console.log(`✓ Full library sync scheduled every ${interval}`)

  // Run once on startup after the server is fully up
  setTimeout(() => {
    console.log("[sync] Running initial sync...")
    runFullSync().catch((err) => console.error("[sync] Initial sync failed:", err.message))
  }, 10_000)
}
