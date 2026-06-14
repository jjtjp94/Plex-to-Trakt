import { describe, it, expect } from "vitest"
import { extractIds } from "../src/services/idParser.js"

describe("extractIds", () => {
  it("returns null for no input", () => {
    expect(extractIds(null)).toBeNull()
    expect(extractIds(undefined)).toBeNull()
    expect(extractIds(null, [])).toBeNull()
  })

  it("extracts tmdb from themoviedb:// format", () => {
    expect(extractIds("themoviedb://12345")).toEqual({ tmdb: 12345 })
  })

  it("extracts tmdb from tmdb:// format", () => {
    expect(extractIds("tmdb://67890")).toEqual({ tmdb: 67890 })
  })

  it("extracts imdb from imdb:// format", () => {
    expect(extractIds("imdb://tt1234567")).toEqual({ imdb: "tt1234567" })
  })

  it("extracts tvdb from thetvdb:// format", () => {
    expect(extractIds("thetvdb://54321")).toEqual({ tvdb: 54321 })
  })

  it("extracts tvdb from tvdb:// format", () => {
    expect(extractIds("tvdb://99999")).toEqual({ tvdb: 99999 })
  })

  it("extracts tvdb with season/episode from thetvdb://id/season/episode", () => {
    expect(extractIds("thetvdb://54321/2/5")).toEqual({ tvdb: 54321, season: 2, episode: 5 })
  })

  it("extracts from com.plexapp.agents.themoviedb format", () => {
    expect(extractIds("com.plexapp.agents.themoviedb://555")).toEqual({ tmdb: 555 })
  })

  it("extracts from com.plexapp.agents.imdb format", () => {
    expect(extractIds("com.plexapp.agents.imdb://tt9999999")).toEqual({ imdb: "tt9999999" })
  })

  it("extracts from com.plexapp.agents.thetvdb with season/episode", () => {
    expect(extractIds("com.plexapp.agents.thetvdb://100/3/7")).toEqual({ tvdb: 100, season: 3, episode: 7 })
  })

  it("falls back to guids array when primary guid is plex://", () => {
    const result = extractIds("plex://movie/abc123", [
      { id: "imdb://tt0000001" },
      { id: "tmdb://42" },
    ])
    expect(result).toEqual({ imdb: "tt0000001" })
  })

  it("handles guids array with string entries", () => {
    const result = extractIds(null, ["tmdb://999"])
    expect(result).toEqual({ tmdb: 999 })
  })

  it("returns null for unknown guid format", () => {
    expect(extractIds("plex://unknown/abc")).toBeNull()
  })
})
