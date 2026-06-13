// Minimal mock of api.trakt.tv for local testing.
// Logs every request it receives and returns 201.
// Usage: node test/mockTrakt.mjs  (listens on :8400)
import http from "http"

http
  .createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      console.log(`[mock-trakt] ${req.method} ${req.url} ${body}`)
      res.writeHead(201, { "Content-Type": "application/json" })
      res.end("{}")
    })
  })
  .listen(8400, () => console.log("[mock-trakt] listening on 8400"))
