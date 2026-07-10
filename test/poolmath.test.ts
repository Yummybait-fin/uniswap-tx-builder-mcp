import { describe, expect, it } from "vitest";

import {
  computeMintAmounts,
  getSqrtRatioAtTick,
  sqrtPriceX96ToPrice,
  suggestRangeTicks,
} from "../src/ticks.js";

// ── getSqrtRatioAtTick ───────────────────────────────────────────────

describe("getSqrtRatioAtTick", () => {
  it("matches the canonical Uniswap v3-core anchors exactly", () => {
    expect(getSqrtRatioAtTick(0)).toBe(79228162514264337593543950336n); // 2^96
    expect(getSqrtRatioAtTick(-887272)).toBe(4295128739n); // MIN_SQRT_RATIO
    expect(getSqrtRatioAtTick(887272)).toBe(
      1461446703485210103287273052203988822378723970342n, // MAX_SQRT_RATIO
    );
  });

  it("tracks the float approximation across the tick range", () => {
    for (const tick of [-500000, -201358, -1000, -1, 1, 1000, 33333, 443636]) {
      const exact = Number(getSqrtRatioAtTick(tick)) / 2 ** 96;
      const approx = 1.0001 ** (tick / 2);
      expect(Math.abs(exact / approx - 1)).toBeLessThan(1e-9);
    }
  });

  it("rejects out-of-range ticks", () => {
    expect(() => getSqrtRatioAtTick(887273)).toThrow("out of range");
    expect(() => getSqrtRatioAtTick(-887273)).toThrow("out of range");
    expect(() => getSqrtRatioAtTick(1.5)).toThrow("out of range");
  });
});

// ── suggestRangeTicks ────────────────────────────────────────────────

describe("suggestRangeTicks", () => {
  it("rounds inward so the range never exceeds ±pct (live-mint vector)", () => {
    // Base WETH/USDC 0.05% at spot tick -201358 (spacing 10), ±2%:
    // exact edges are ∓198.0 ticks → inward-aligned to -201550/-201160.
    const r = suggestRangeTicks(-201358, 10, 2);
    expect(r.tickLower).toBe(-201550);
    expect(r.tickUpper).toBe(-201160);
    expect(r.pctBelow).toBeGreaterThan(-2);
    expect(r.pctBelow).toBeLessThan(0);
    expect(r.pctAbove).toBeGreaterThan(0);
    expect(r.pctAbove).toBeLessThanOrEqual(2);
  });

  it("stays inward on an already-aligned spot tick", () => {
    const r = suggestRangeTicks(0, 60, 1);
    // ±1% ≈ ±99.5 ticks → inward to ±60.
    expect(r.tickLower).toBe(-60);
    expect(r.tickUpper).toBe(60);
  });

  it("rejects a range too narrow for the spacing", () => {
    expect(() => suggestRangeTicks(0, 200, 0.5)).toThrow("too narrow");
    expect(() => suggestRangeTicks(0, 60, -1)).toThrow("positive");
  });
});

// ── computeMintAmounts ───────────────────────────────────────────────

describe("computeMintAmounts", () => {
  // The first live mint's inputs: spot tick -201358, range [-201560, -201170],
  // balances 0.00056 WETH / 1.007655 USDC. Expected amounts cross-checked
  // against the byte-verified reference (onchain-toolkit pool-state.py):
  // identical amount1/limitingSide; amount0 differs by ~2.5e-12 relative
  // (this port uses the exact on-chain TickMath, the script used float sqrt).
  const SQRT_P = getSqrtRatioAtTick(-201358);
  const B0 = 560000000000000n;
  const B1 = 1007655n;

  it("computes live-ratio amounts with the correct limiting side", () => {
    const r = computeMintAmounts(SQRT_P, -201560, -201170, B0, B1);
    expect(r.amount0Desired).toBe(520834455524438n);
    expect(r.amount1Desired).toBe(1007654n);
    expect(r.limitingSide).toBe("token1");
    // Never asks for more than the balances hold.
    expect(r.amount0Desired <= B0).toBe(true);
    expect(r.amount1Desired <= B1).toBe(true);
  });

  it("consumes (almost) the whole limiting-side balance", () => {
    const r = computeMintAmounts(SQRT_P, -201560, -201170, B0, B1);
    // limiting side is token1 → amount1 ≈ balance1 (floor-rounding dust only)
    expect(B1 - r.amount1Desired).toBeLessThanOrEqual(2n);
  });

  it("is symmetric: a huge token1 balance flips the limiting side", () => {
    const r = computeMintAmounts(SQRT_P, -201560, -201170, B0, B1 * 1000n);
    expect(r.limitingSide).toBe("token0");
    // token0 goes through liquidity floor-rounding twice → wei-scale dust,
    // but never more than a ppb of the balance (and never over it).
    expect(r.amount0Desired <= B0).toBe(true);
    expect(B0 - r.amount0Desired).toBeLessThan(B0 / 1_000_000_000n);
  });

  it("throws when spot is outside the range (single-sided mint)", () => {
    expect(() =>
      computeMintAmounts(SQRT_P, -201170, -200000, B0, B1),
    ).toThrow("single-sided");
    expect(() =>
      computeMintAmounts(SQRT_P, -210000, -201560, B0, B1),
    ).toThrow("single-sided");
  });

  it("rejects an inverted range", () => {
    expect(() =>
      computeMintAmounts(SQRT_P, -201170, -201560, B0, B1),
    ).toThrow("tickLower must be < tickUpper");
  });
});

// ── sqrtPriceX96ToPrice ──────────────────────────────────────────────

describe("sqrtPriceX96ToPrice", () => {
  it("converts the live-mint spot to a human price", () => {
    // Journal recorded "spot 1801.30 USDC/WETH at tick -201358".
    const price = sqrtPriceX96ToPrice(getSqrtRatioAtTick(-201358), 18, 6);
    expect(price).toBeGreaterThan(1801);
    expect(price).toBeLessThan(1802);
  });

  it("is the identity at tick 0 with equal decimals", () => {
    expect(sqrtPriceX96ToPrice(getSqrtRatioAtTick(0), 18, 18)).toBeCloseTo(1, 12);
  });
});
