import { describe, it, expect } from "vitest"
import { computeProgress } from "../src/services/traktScrobble.js"

describe("computeProgress", () => {
  it("returns 0 when viewOffset is 0", () => {
    expect(computeProgress(0, 7200000)).toBe(0)
  })

  it("returns 0 when duration is 0", () => {
    expect(computeProgress(1000, 0)).toBe(0)
  })

  it("returns 0 when duration is negative", () => {
    expect(computeProgress(1000, -1)).toBe(0)
  })

  it("returns 0 when both are undefined", () => {
    expect(computeProgress(undefined, undefined)).toBe(0)
  })

  it("calculates correct percentage", () => {
    expect(computeProgress(3600000, 7200000)).toBe(50)
  })

  it("rounds to 2 decimal places", () => {
    expect(computeProgress(1000, 3000)).toBe(33.33)
  })

  it("caps at 100", () => {
    expect(computeProgress(8000, 7000)).toBe(100)
  })

  it("handles very small progress (rounds to 0 at extreme ratios)", () => {
    // 1ms / 7200000ms rounds to 0.00 at 2 decimal places
    expect(computeProgress(1, 7200000)).toBe(0)
    // But a larger offset still registers
    expect(computeProgress(72000, 7200000)).toBe(1)
  })
})
