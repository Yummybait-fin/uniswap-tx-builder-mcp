/**
 * Pure Uniswap v3 tick math — no RPC, no I/O. Converts human-readable prices
 * into the aligned ticks a position uses, and live pool readings into
 * range suggestions and mint amounts.
 *
 * A pool price is `token1` per `token0` expressed in each token's *smallest*
 * unit. A human price `P` ("how many whole token1 per whole token0") relates
 * to the raw price by `raw = P * 10^(decimals1 - decimals0)`, and
 * `tick = log(raw) / log(1.0001)`.
 */

// Uniswap v3 tick bounds.
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

const LOG_BASE = Math.log(1.0001);

/** Standard fee tier → tick spacing. */
export const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

export function feeToTickSpacing(fee: number): number {
  const spacing = FEE_TO_TICK_SPACING[fee];
  if (!spacing) {
    const known = Object.keys(FEE_TO_TICK_SPACING).join(", ");
    throw new Error(`Unknown fee tier ${fee}. Supported: ${known}.`);
  }
  return spacing;
}

/**
 * Convert a human price (token1 per token0) to the (unaligned) tick.
 * `price` must be > 0.
 */
export function priceToTick(
  price: number,
  decimals0: number,
  decimals1: number,
): number {
  if (!(price > 0)) {
    throw new Error(`Price must be a positive number, got ${price}`);
  }
  const raw = price * 10 ** (decimals1 - decimals0);
  return Math.log(raw) / LOG_BASE;
}

/** Snap a tick to the nearest usable tick for `spacing`, clamped to bounds. */
export function alignTick(tick: number, spacing: number): number {
  const snapped = Math.round(tick / spacing) * spacing;
  const minAligned = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxAligned = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(Math.max(snapped, minAligned), maxAligned);
}

export interface TickRange {
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
}

/**
 * Convert a human price range to aligned [tickLower, tickUpper] for `fee`.
 * Prices are reordered if given high→low, and the bounds are guaranteed to
 * differ by at least one tick spacing.
 */
export function priceRangeToTicks(
  priceLower: number,
  priceUpper: number,
  fee: number,
  decimals0: number,
  decimals1: number,
): TickRange {
  const tickSpacing = feeToTickSpacing(fee);

  const [lo, hi] =
    priceLower <= priceUpper
      ? [priceLower, priceUpper]
      : [priceUpper, priceLower];

  let tickLower = alignTick(priceToTick(lo, decimals0, decimals1), tickSpacing);
  let tickUpper = alignTick(priceToTick(hi, decimals0, decimals1), tickSpacing);

  if (tickLower >= tickUpper) {
    // Range collapsed after alignment — widen to one spacing, staying in bounds.
    const maxAligned = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
    if (tickLower >= maxAligned) {
      tickLower = maxAligned - tickSpacing;
      tickUpper = maxAligned;
    } else {
      tickUpper = tickLower + tickSpacing;
    }
  }

  return { tickLower, tickUpper, tickSpacing };
}

// ─── TickMath.getSqrtRatioAtTick (exact port of Uniswap v3-core) ─────

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

// One 128-bit multiplier per tick bit: sqrt(1.0001)^-(2^i) in Q128.
const TICK_MULTIPLIERS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/**
 * Q64.96 sqrt price at a tick — bit-for-bit identical to the on-chain
 * `TickMath.getSqrtRatioAtTick`, so amounts derived from it match what the
 * pool computes.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`Tick out of range: ${tick}`);
  }
  const absTick = Math.abs(tick);
  let ratio =
    (absTick & 1) !== 0 ? TICK_MULTIPLIERS[0] : 1n << 128n;
  for (let i = 1; i < TICK_MULTIPLIERS.length; i++) {
    if ((absTick >> i) & 1) {
      ratio = (ratio * TICK_MULTIPLIERS[i]) >> 128n;
    }
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q64.96, rounding up.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// ─── live-pool helpers (spot tick / sqrtPrice in, plan values out) ────

export interface SuggestedRange {
  tickLower: number;
  tickUpper: number;
  /** Actual (post-rounding) range edges relative to spot, in percent. */
  pctBelow: number;
  pctAbove: number;
}

/**
 * Ticks within ±`rangePct` of the spot tick, rounded INWARD to `tickSpacing`
 * — outward rounding would exceed the caller's stated max width.
 */
export function suggestRangeTicks(
  tick: number,
  tickSpacing: number,
  rangePct: number,
): SuggestedRange {
  if (!(rangePct > 0)) {
    throw new Error(`rangePct must be positive, got ${rangePct}`);
  }
  const delta = Math.log(1 + rangePct / 100) / LOG_BASE;
  const tickLower = Math.ceil((tick - delta) / tickSpacing) * tickSpacing;
  const tickUpper = Math.floor((tick + delta) / tickSpacing) * tickSpacing;
  if (tickLower >= tickUpper) {
    throw new Error(
      `Range ±${rangePct}% is too narrow for tick spacing ${tickSpacing} — widen it.`,
    );
  }
  return {
    tickLower,
    tickUpper,
    pctBelow: (1.0001 ** (tickLower - tick) - 1) * 100,
    pctAbove: (1.0001 ** (tickUpper - tick) - 1) * 100,
  };
}

export interface MintAmounts {
  amount0Desired: bigint;
  amount1Desired: bigint;
  /** Which balance caps the position's liquidity. */
  limitingSide: "token0" | "token1";
}

/**
 * The largest both-sided deposit the balances allow at the LIVE pool price:
 * per-side liquidity `L0`/`L1` from the full balances, `L = min(L0, L1)`,
 * then back out the exact amounts that liquidity consumes. Feeding these to
 * `mint` matches the pool's own math, so slippage mins can stay tight.
 *
 * Throws when the spot price is outside [tickLower, tickUpper] — such a mint
 * is single-sided and the caller should recompute the range instead.
 */
export function computeMintAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  balance0: bigint,
  balance1: bigint,
): MintAmounts {
  if (tickLower >= tickUpper) {
    throw new Error(`tickLower must be < tickUpper (${tickLower} >= ${tickUpper})`);
  }
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);
  if (!(sqrtLower < sqrtPriceX96 && sqrtPriceX96 < sqrtUpper)) {
    throw new Error(
      `Spot price is outside [${tickLower}, ${tickUpper}] — a mint there would be ` +
        "single-sided; recompute the range around the current tick.",
    );
  }
  const l0 =
    (balance0 * ((sqrtPriceX96 * sqrtUpper) / Q96)) / (sqrtUpper - sqrtPriceX96);
  const l1 = (balance1 * Q96) / (sqrtPriceX96 - sqrtLower);
  const liquidity = l0 < l1 ? l0 : l1;
  return {
    amount0Desired:
      (liquidity * (sqrtUpper - sqrtPriceX96) * Q96) / (sqrtUpper * sqrtPriceX96),
    amount1Desired: (liquidity * (sqrtPriceX96 - sqrtLower)) / Q96,
    limitingSide: l0 < l1 ? "token0" : "token1",
  };
}

/** Human price (token1 per token0) from a Q64.96 sqrt price. */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return ratio * ratio * 10 ** (decimals0 - decimals1);
}
