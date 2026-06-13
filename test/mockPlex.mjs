// Minimal mock of a Plex server's /status/sessions endpoint.
// Serves whatever JSON is in /tmp/mock-plex-sessions.json so tests can
// mutate playback state between polls.
// Usage: node test/mockPlex.mjs  (listens on :8401)
import http from "http"
import { readFileSync } from "fs"

http
  .createServer((req, res) => {
    let sessions = []
    try {
      sessions = JSON.parse(readFileSync("/tmp/mock-plex-sessions.json", "utf8"))
    } catch {}
    console.log(`[mock-plex] ${req.method} ${req.url} -> ${sessions.length} session(s)`)
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ MediaContainer: { size: sessions.length, Metadata: sessions } }))
  })
  .listen(8401, () => console.log("[mock-plex] listening on 8401"))
