import {
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  http,
  parseUnits,
} from "viem";

import { erc20Abi, nfpmAbi } from "./abi.js";
import { getChain } from "./config.js";
import { priceRangeToTicks } from "./ticks.js";

const MAX_UINT128 = (1n << 128n) - 1n;
const DEADLINE_SECS = 1800; // 30 minutes
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.5%

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string; // "0" — always non-payable for these calls
  chainId: number;
}

export interface PositionInfo {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

// ─── helpers ────────────────────────────────────────────────────────

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECS);
}

/** Lower bound after applying `slippageBps` (default 0.5%) to a desired amount. */
function minWithSlippage(desired: bigint, slippageBps?: number): bigint {
  const bps = slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : BigInt(slippageBps);
  return desired - (desired * bps) / 10000n;
}

async function readPosition(
  chainId: number,
  positionId: bigint,
): Promise<PositionInfo> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const result = await client.readContract({
    address: cfg.nfpm,
    abi: nfpmAbi,
    functionName: "positions",
    args: [positionId],
  });

  // positions() returns a 12-element tuple
  return {
    token0: result[2],
    token1: result[3],
    fee: result[4],
    tickLower: result[5],
    tickUpper: result[6],
    liquidity: result[7],
  };
}

// ─── collect ────────────────────────────────────────────────────────

export async function buildCollectTx(
  chainId: number,
  positionId: bigint,
  recipient: Address,
): Promise<UnsignedTx> {
  const cfg = getChain(chainId);

  const data = encodeFunctionData({
    abi: nfpmAbi,
    functionName: "collect",
    args: [
      {
        tokenId: positionId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
    ],
  });

  return { to: cfg.nfpm, data, value: "0", chainId };
}

// ─── close (decreaseLiquidity + collect) ────────────────────────────

export async function buildCloseTx(
  chainId: number,
  positionId: bigint,
  recipient: Address,
  burn = false,
): Promise<{ tx: UnsignedTx; position: PositionInfo }> {
  const cfg = getChain(chainId);
  const position = await readPosition(chainId, positionId);

  const calls: Hex[] = [];

  // 1. Remove all liquidity (if any)
  if (position.liquidity > 0n) {
    calls.push(
      encodeFunctionData({
        abi: nfpmAbi,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: positionId,
            liquidity: position.liquidity,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: deadline(),
          },
        ],
      }),
    );
  }

  // 2. Collect all tokens + fees
  calls.push(
    encodeFunctionData({
      abi: nfpmAbi,
      functionName: "collect",
      args: [
        {
          tokenId: positionId,
          recipient,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    }),
  );

  // 3. Optionally burn the now-empty NFT (requires liquidity + owed both zero,
  // which the calls above guarantee).
  if (burn) {
    calls.push(
      encodeFunctionData({
        abi: nfpmAbi,
        functionName: "burn",
        args: [positionId],
      }),
    );
  }

  // Wrap in multicall if > 1 call, otherwise send directly
  const data =
    calls.length === 1
      ? calls[0]
      : encodeFunctionData({
          abi: nfpmAbi,
          functionName: "multicall",
          args: [calls],
        });

  return {
    tx: { to: cfg.nfpm, data, value: "0", chainId },
    position,
  };
}

// ─── simulate (dry-run via eth_call) ─────────────────────────────────

export async function simulateTx(
  chainId: number,
  tx: UnsignedTx,
  from: Address,
): Promise<void> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  await client.call({
    account: from,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
  });
}

// ─── mint (for rebalance step 2) ────────────────────────────────────

export interface MintParams {
  chainId: number;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  recipient: Address;
  slippageBps?: number;
}

export function buildMintTx(params: MintParams): UnsignedTx {
  const cfg = getChain(params.chainId);

  const amount0Min = minWithSlippage(params.amount0Desired, params.slippageBps);
  const amount1Min = minWithSlippage(params.amount1Desired, params.slippageBps);

  const data = encodeFunctionData({
    abi: nfpmAbi,
    functionName: "mint",
    args: [
      {
        token0: params.token0,
        token1: params.token1,
        fee: params.fee,
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min,
        amount1Min,
        recipient: params.recipient,
        deadline: deadline(),
      },
    ],
  });

  return { to: cfg.nfpm, data, value: "0", chainId: params.chainId };
}

// ─── increaseLiquidity (add to an existing position) ─────────────────

export interface IncreaseParams {
  chainId: number;
  positionId: bigint;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps?: number;
}

export function buildIncreaseLiquidityTx(params: IncreaseParams): UnsignedTx {
  const cfg = getChain(params.chainId);

  const data = encodeFunctionData({
    abi: nfpmAbi,
    functionName: "increaseLiquidity",
    args: [
      {
        tokenId: params.positionId,
        amount0Desired: params.amount0Desired,
        amount1Desired: params.amount1Desired,
        amount0Min: minWithSlippage(params.amount0Desired, params.slippageBps),
        amount1Min: minWithSlippage(params.amount1Desired, params.slippageBps),
        deadline: deadline(),
      },
    ],
  });

  return { to: cfg.nfpm, data, value: "0", chainId: params.chainId };
}

// ─── plan (human price range + amounts → ticks + wei) ────────────────

export interface PlanPositionParams {
  chainId: number;
  token0: Address;
  token1: Address;
  fee: number;
  priceLower: number; // token1 per token0, human units
  priceUpper: number;
  amount0?: string; // human (whole-token) decimal strings
  amount1?: string;
}

export interface PlanPositionResult {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
  amount0Desired: string; // wei
  amount1Desired: string; // wei
}

/**
 * Resolve a human-readable position spec into the raw values `build_mint`
 * needs: reads each token's decimals over RPC, converts the price range to
 * aligned ticks, and parses human amounts to wei. Does not compute the optimal
 * amount ratio for the range — pass the amounts you intend to deposit.
 */
export async function planPosition(
  params: PlanPositionParams,
): Promise<PlanPositionResult> {
  // Uniswap requires token0 < token1 (sorted by address). Reject otherwise so
  // the caller swaps the pair and inverts the price rather than minting garbage.
  if (BigInt(params.token0) >= BigInt(params.token1)) {
    throw new Error(
      "token0 must be < token1 (sort by address); swap the pair and invert the price range.",
    );
  }

  const cfg = getChain(params.chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: params.token0, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: params.token1, abi: erc20Abi, functionName: "decimals" }),
  ]);

  const { tickLower, tickUpper, tickSpacing } = priceRangeToTicks(
    params.priceLower,
    params.priceUpper,
    params.fee,
    decimals0,
    decimals1,
  );

  return {
    token0: params.token0,
    token1: params.token1,
    fee: params.fee,
    tickLower,
    tickUpper,
    tickSpacing,
    decimals0,
    decimals1,
    amount0Desired: parseUnits(params.amount0 ?? "0", decimals0).toString(),
    amount1Desired: parseUnits(params.amount1 ?? "0", decimals1).toString(),
  };
}
