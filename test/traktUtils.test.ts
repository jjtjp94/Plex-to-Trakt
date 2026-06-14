import { describe, it, expect } from "vitest"
import { traktHeaders, idKeys, episodeKeys } from "../src/services/traktUtils.js"

describe("traktHeaders", () => {
  it("builds correct headers", () => {
    const user = { traktClientId: "client123", traktAccessToken: "token456" }
    const headers = traktHeaders(user)
    expect(headers).toEqual({
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": "client123",
      Authorization: "Bearer token456",
    })
  })
})

describe("idKeys", () => {
  it("returns empty array for empty ids", () => {
    expect(idKeys({})).toEqual([])
  })

  it("returns imdb key", () => {
    expect(idKeys({ imdb: "tt1234567" })).toEqual(["imdb:tt1234567"])
  })

  it("returns tmdb key", () => {
    expect(idKeys({ tmdb: 42 })).toEqual(["tmdb:42"])
  })

  it("returns tvdb key", () => {
    expect(idKeys({ tvdb: 99 })).toEqual(["tvdb:99"])
  })

  it("returns all keys when all IDs present", () => {
    const keys = idKeys({ imdb: "tt1", tmdb: 2, tvdb: 3 })
    expect(keys).toEqual(["imdb:tt1", "tmdb:2", "tvdb:3"])
  })

  it("skips falsy values", () => {
    expect(idKeys({ imdb: "", tmdb: 0, tvdb: null })).toEqual([])
  })
})

describe("episodeKeys", () => {
  it("returns empty array for empty show ids", () => {
    expect(episodeKeys({}, 1, 1)).toEqual([])
  })

  it("builds composite keys with season and episode", () => {
    const keys = episodeKeys({ imdb: "tt1", tmdb: 2 }, 3, 5)
    expect(keys).toEqual(["imdb:tt1:s3e5", "tmdb:2:s3e5"])
  })

  it("handles single ID", () => {
    expect(episodeKeys({ tvdb: 100 }, 1, 2)).toEqual(["tvdb:100:s1e2"])
  })
})
