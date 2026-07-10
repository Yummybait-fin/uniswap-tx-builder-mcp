import {
  type Address,
  type Hex,
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
  parseUnits,
  serializeTransaction,
} from "viem";

import {
  erc20Abi,
  factoryAbi,
  nfpmAbi,
  poolAbi,
  universalRouterAbi,
} from "./abi.js";
import { getChain } from "./config.js";
import {
  type MintAmounts,
  type SuggestedRange,
  computeMintAmounts,
  priceRangeToTicks,
  sqrtPriceX96ToPrice,
  suggestRangeTicks,
} from "./ticks.js";

const MAX_UINT128 = (1n << 128n) - 1n;
const DEADLINE_SECS = 1800; // 30 minutes
const UR_DEADLINE_SECS = 1200; // 20 minutes — Universal Router wrap/swap
const DEFAULT_SLIPPAGE_BPS = 50n; // 0.5%

export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: string; // wei; "0" except Universal Router wrap/swap (payable)
  chainId: number;
}

/**
 * Unsigned EIP-1559 (type-2) serialization of a built tx:
 * `0x02 || rlp([chainId, 0, 0, 0, 0, to, value, data, []])`. Nonce, both fee
 * fields and gasLimit are zeroed by design — signing services (e.g. the CDP
 * API) populate them at signing time. Callers that manage their own nonces
 * should serialize `tx` themselves instead.
 */
export function toUnsignedRlp(tx: UnsignedTx): Hex {
  return serializeTransaction({
    type: "eip1559",
    chainId: tx.chainId,
    nonce: 0,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 0n,
    gas: 0n,
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    accessList: [],
  });
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

// ─── pool state (live spot + range suggestion + live-ratio amounts) ──

export interface PoolStateParams {
  chainId: number;
  token0: Address;
  token1: Address;
  fee: number;
  rangePct?: number;
  tickLower?: number;
  tickUpper?: number;
  balance0?: bigint;
  balance1?: bigint;
}

export interface PoolStateResult {
  pool: Address;
  tick: number;
  tickSpacing: number;
  sqrtPriceX96: string;
  price: number; // token1 per token0, human units
  decimals0: number;
  decimals1: number;
  suggested?: SuggestedRange;
  mintAmounts?: {
    amount0Desired: string;
    amount1Desired: string;
    limitingSide: MintAmounts["limitingSide"];
  };
}

/**
 * Read a pool's LIVE state and derive the values a mint needs from it in the
 * same breath: optional ±pct tick range (rounded inward to spacing) and
 * optional `amount0Desired`/`amount1Desired` computed from the current
 * sqrtPrice ratio — amounts computed from stale prices revert the mint with
 * "Price slippage check".
 */
export async function getPoolState(
  params: PoolStateParams,
): Promise<PoolStateResult> {
  if (BigInt(params.token0) >= BigInt(params.token1)) {
    throw new Error(
      "token0 must be < token1 (sort by address); swap the pair.",
    );
  }
  const wantAmounts =
    params.balance0 !== undefined || params.balance1 !== undefined;
  if (
    wantAmounts &&
    (params.balance0 === undefined ||
      params.balance1 === undefined ||
      params.tickLower === undefined ||
      params.tickUpper === undefined)
  ) {
    throw new Error(
      "Mint amounts need all of balance0, balance1, tickLower, tickUpper " +
        "(get a range from rangePct first).",
    );
  }

  const cfg = getChain(params.chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const pool = await client.readContract({
    address: cfg.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [params.token0, params.token1, params.fee],
  });
  if (BigInt(pool) === 0n) {
    throw new Error(
      `No pool for ${params.token0}/${params.token1} fee=${params.fee} on chain ${params.chainId}`,
    );
  }

  const [slot0, tickSpacing, decimals0, decimals1] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "tickSpacing" }),
    client.readContract({ address: params.token0, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: params.token1, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const [sqrtPriceX96, tick] = slot0;

  const result: PoolStateResult = {
    pool,
    tick,
    tickSpacing,
    sqrtPriceX96: sqrtPriceX96.toString(),
    price: sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1),
    decimals0,
    decimals1,
  };

  if (params.rangePct !== undefined) {
    result.suggested = suggestRangeTicks(tick, tickSpacing, params.rangePct);
  }

  if (wantAmounts) {
    const amounts = computeMintAmounts(
      sqrtPriceX96,
      params.tickLower as number,
      params.tickUpper as number,
      params.balance0 as bigint,
      params.balance1 as bigint,
    );
    result.mintAmounts = {
      amount0Desired: amounts.amount0Desired.toString(),
      amount1Desired: amounts.amount1Desired.toString(),
      limitingSide: amounts.limitingSide,
    };
  }

  return result;
}

// ─── Universal Router wrap / swap ────────────────────────────────────

// UR command bytes (Commands.sol).
const CMD_V3_SWAP_EXACT_IN = "00";
const CMD_SWEEP = "04";
const CMD_WRAP_ETH = "0b";

// UR recipient placeholder the router resolves to msg.sender at execution —
// safer than a literal address when the output goes back to the signer.
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";
// Placeholder for the router itself (intermediate custody within one execute).
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";

function urDeadline(deadline?: number): bigint {
  return BigInt(deadline ?? Math.floor(Date.now() / 1000) + UR_DEADLINE_SECS);
}

function urExecute(
  chainId: number,
  commands: Hex,
  inputs: Hex[],
  value: bigint,
  deadline?: number,
): UnsignedTx {
  const cfg = getChain(chainId);
  const data = encodeFunctionData({
    abi: universalRouterAbi,
    functionName: "execute",
    args: [commands, inputs, urDeadline(deadline)],
  });
  return { to: cfg.universalRouter, data, value: value.toString(), chainId };
}

export interface WrapParams {
  chainId: number;
  amountWei: bigint;
  recipient?: Address; // default: the tx sender (MSG_SENDER placeholder)
  deadline?: number; // unix seconds; default now + 20 min
}

/**
 * Native ETH → wrapped native (WETH9) via Universal Router `WRAP_ETH` — a
 * direct `WETH.deposit()` is unusable under NFPM/UR-scoped wallet policies.
 * The tx is payable: `value` carries the ETH being wrapped.
 */
export function buildWrapTx(params: WrapParams): UnsignedTx {
  const input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [params.recipient ?? MSG_SENDER, params.amountWei],
  );
  return urExecute(
    params.chainId,
    `0x${CMD_WRAP_ETH}`,
    [input],
    params.amountWei,
    params.deadline,
  );
}

export interface SwapParams {
  chainId: number;
  amountInWei: bigint;
  tokenOut: Address;
  fee: number; // pool fee tier for the WETH9→tokenOut hop
  amountOutMin: bigint;
  recipient?: Address; // default: the tx sender (MSG_SENDER placeholder)
  /**
   * Wrap this much native ETH first (≥ amountInWei); the un-swapped remainder
   * is swept back to `recipient` as WETH. Omit when the wallet already holds
   * WETH — that variant pays through Permit2, so the wallet needs a Permit2
   * approval for WETH9 rather than a plain ERC-20 approval to the router.
   */
  wrapWei?: bigint;
  deadline?: number; // unix seconds; default now + 20 min
}

/**
 * Exact-in single-hop v3 swap WETH9 → `tokenOut` via Universal Router.
 * With `wrapWei`: `WRAP_ETH(ADDRESS_THIS)` + `V3_SWAP_EXACT_IN(payerIsUser=
 * false)` + `SWEEP(WETH9, recipient, remainder)` in one payable tx — the
 * "wallet holds native ETH but the position needs WETH/ERC-20" path.
 */
export function buildSwapTx(params: SwapParams): UnsignedTx {
  const cfg = getChain(params.chainId);
  const recipient = params.recipient ?? MSG_SENDER;
  const path = encodePacked(
    ["address", "uint24", "address"],
    [cfg.weth9, params.fee, params.tokenOut],
  );
  const swapInput = (payerIsUser: boolean) =>
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "bool" },
      ],
      [recipient, params.amountInWei, params.amountOutMin, path, payerIsUser],
    );

  if (params.wrapWei === undefined) {
    return urExecute(
      params.chainId,
      `0x${CMD_V3_SWAP_EXACT_IN}`,
      [swapInput(true)],
      0n,
      params.deadline,
    );
  }

  if (params.wrapWei < params.amountInWei) {
    throw new Error(
      `wrapWei (${params.wrapWei}) must cover amountInWei (${params.amountInWei})`,
    );
  }
  const wrapInput = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [ADDRESS_THIS, params.wrapWei],
  );
  const sweepInput = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [cfg.weth9, recipient, params.wrapWei - params.amountInWei],
  );
  return urExecute(
    params.chainId,
    `0x${CMD_WRAP_ETH}${CMD_V3_SWAP_EXACT_IN}${CMD_SWEEP}`,
    [wrapInput, swapInput(false), sweepInput],
    params.wrapWei,
    params.deadline,
  );
}
