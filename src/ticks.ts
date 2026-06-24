/**
 * Pure Uniswap v3 tick math — no RPC, no I/O. Converts human-readable prices
 * into the aligned ticks a position uses.
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
