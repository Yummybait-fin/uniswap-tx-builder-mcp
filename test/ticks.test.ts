import { describe, expect, it } from "vitest";

import {
  MAX_TICK,
  MIN_TICK,
  alignTick,
  feeToTickSpacing,
  priceRangeToTicks,
  priceToTick,
} from "../src/ticks.js";

describe("feeToTickSpacing", () => {
  it.each([
    [100, 1],
    [500, 10],
    [3000, 60],
    [10000, 200],
  ])("maps fee %i to spacing %i", (fee, spacing) => {
    expect(feeToTickSpacing(fee)).toBe(spacing);
  });

  it("throws on an unknown fee tier", () => {
    expect(() => feeToTickSpacing(1234)).toThrow("Unknown fee tier");
  });
});

describe("priceToTick", () => {
  it("returns ~0 for price 1 with equal decimals", () => {
    expect(priceToTick(1, 18, 18)).toBeCloseTo(0, 6);
  });

  it("accounts for decimal difference", () => {
    // price 1 with d0=6,d1=18 → raw = 1e12 → tick = ln(1e12)/ln(1.0001)
    const expected = Math.log(1e12) / Math.log(1.0001);
    expect(priceToTick(1, 6, 18)).toBeCloseTo(expected, 3);
  });

  it("rejects non-positive prices", () => {
    expect(() => priceToTick(0, 18, 18)).toThrow("positive");
    expect(() => priceToTick(-5, 18, 18)).toThrow("positive");
  });
});

describe("alignTick", () => {
  it("snaps to the nearest multiple of spacing", () => {
    expect(alignTick(133, 60)).toBe(120);
    expect(alignTick(150, 60)).toBe(180);
    expect(alignTick(-133, 60)).toBe(-120);
  });

  it("clamps to the aligned tick bounds", () => {
    const spacing = 60;
    expect(alignTick(1_000_000, spacing)).toBe(
      Math.floor(MAX_TICK / spacing) * spacing,
    );
    expect(alignTick(-1_000_000, spacing)).toBe(
      Math.ceil(MIN_TICK / spacing) * spacing,
    );
  });
});

describe("priceRangeToTicks", () => {
  it("produces aligned, ordered ticks", () => {
    const r = priceRangeToTicks(1500, 2500, 3000, 18, 18);
    expect(r.tickSpacing).toBe(60);
    expect(r.tickLower % 60).toBe(0);
    expect(r.tickUpper % 60).toBe(0);
    expect(r.tickLower).toBeLessThan(r.tickUpper);
  });

  it("reorders a high→low price range", () => {
    const asc = priceRangeToTicks(1500, 2500, 3000, 18, 18);
    const desc = priceRangeToTicks(2500, 1500, 3000, 18, 18);
    expect(desc).toEqual(asc);
  });

  it("widens a collapsed range to one spacing", () => {
    // Identical prices align to the same tick → must be pushed apart.
    const r = priceRangeToTicks(2000, 2000, 3000, 18, 18);
    expect(r.tickUpper - r.tickLower).toBe(60);
  });

  it("widens downward when the range collapses at MAX_TICK", () => {
    // Both prices clamp to the top aligned tick — the only way to widen is down.
    const r = priceRangeToTicks(1e40, 1e40, 3000, 18, 18);
    const maxAligned = Math.floor(MAX_TICK / 60) * 60;
    expect(r.tickUpper).toBe(maxAligned);
    expect(r.tickLower).toBe(maxAligned - 60);
  });
});
