import express from "express"
import { prisma } from "../services/prisma.js"
import { restartPoller } from "../services/watchStatePoller.js"
import { restartSyncScheduler } from "../services/syncScheduler.js"

const router = express.Router()

const EDITABLE_KEYS = [
  "SYNC_INTERVAL",
  "SYNC_UNWATCHED",
  "WATCH_POLL_INTERVAL",
  "WS_ENABLED",
  "INTRO_DETECTION_ENABLED",
  "ACTIVITY_BUFFER_SIZE",
] as const

type EditableKey = (typeof EDITABLE_KEYS)[number]

const VALIDATORS: Record<EditableKey, (v: string) => string | null> = {
  SYNC_INTERVAL: (v) => {
    if (["3h", "6h", "12h", "24h", "off", ""].includes(v)) return null
    return "Must be 3h, 6h, 12h, 24h, off, or empty"
  },
  SYNC_UNWATCHED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  WATCH_POLL_INTERVAL: (v) => {
    if (v === "" || v === "0") return null
    const n = parseInt(v, 10)
    if (isNaN(n) || n < 5 || n > 3600) return "Must be 5-3600 (seconds) or 0 to disable"
    return null
  },
  WS_ENABLED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  INTRO_DETECTION_ENABLED: (v) => {
    if (["true", "false"].includes(v)) return null
    return "Must be true or false"
  },
  ACTIVITY_BUFFER_SIZE: (v) => {
    const n = parseInt(v, 10)
    if (isNaN(n) || n < 10 || n > 1000) return "Must be 10-1000"
    return null
  },
}

router.get("/", async (_req, res) => {
  const dbSettings = await prisma.setting.findMany()
  const dbMap = new Map(dbSettings.map((s) => [s.key, s.value]))

  const settings: Record<string, string> = {}
  for (const key of EDITABLE_KEYS) {
    settings[key] = dbMap.get(key) ?? process.env[key] ?? ""
  }
  res.json(settings)
})

router.patch("/", async (req, res) => {
  const updates = req.body as Record<string, string>
  if (!updates || typeof updates !== "object") {
    return res.status(400).json({ error: "Body must be a JSON object" })
  }

  const errors: Record<string, string> = {}
  const applied: string[] = []

  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.includes(key as EditableKey)) {
      errors[key] = "Not an editable setting"
      continue
    }

    const strVal = String(value)
    const err = VALIDATORS[key as EditableKey](strVal)
    if (err) {
      errors[key] = err
      continue
    }

    process.env[key] = strVal
    await prisma.setting.upsert({
      where: { key },
      update: { value: strVal },
      create: { key, value: strVal },
    })
    applied.push(key)
  }

  if (Object.keys(errors).length > 0 && applied.length === 0) {
    return res.status(400).json({ errors })
  }

  if (applied.includes("WATCH_POLL_INTERVAL")) {
    restartPoller()
  }
  if (applied.includes("SYNC_INTERVAL")) {
    restartSyncScheduler()
  }

  res.json({ applied, errors: Object.keys(errors).length > 0 ? errors : undefined })
})

export default router

export async function loadSettingsFromDb() {
  try {
    const settings = await prisma.setting.findMany()
    for (const s of settings) {
      if (EDITABLE_KEYS.includes(s.key as EditableKey)) {
        process.env[s.key] = s.value
      }
    }
    if (settings.length > 0) {
      console.log(`[settings] Loaded ${settings.length} setting(s) from database`)
    }
  } catch {
    // DB may not be migrated yet on first run
  }
}
