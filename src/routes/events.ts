import express from "express"
import { subscribe, getHistory } from "../services/eventBus.js"

const router = express.Router()

router.get("/", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  for (const event of getHistory()) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const unsubscribe = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })

  req.on("close", unsubscribe)
})

export default router
