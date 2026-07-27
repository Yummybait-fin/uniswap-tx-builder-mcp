import {
  type Address,
  type Hex,
  createPublicClient,
  decodeFunctionResult,
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
  permit2Abi,
  poolAbi,
  quoterV2Abi,
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

// ─── positions by owner (ERC-721 enumeration) ───────────────────────

export interface OwnedPosition {
  positionId: string;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
}

/**
 * List every Uniswap v3 position NFT `owner` holds on `chainId`, via the
 * NFPM's ERC-721 enumeration (`balanceOf` + `tokenOfOwnerByIndex`), with each
 * position's full on-chain state (`positions`).
 */
export async function getPositionsByOwner(
  chainId: number,
  owner: Address,
): Promise<OwnedPosition[]> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const balance = await client.readContract({
    address: cfg.nfpm,
    abi: nfpmAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  const tokenIds = await Promise.all(
    Array.from({ length: Number(balance) }, (_, index) =>
      client.readContract({
        address: cfg.nfpm,
        abi: nfpmAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(index)],
      }),
    ),
  );

  const positions = await Promise.all(
    tokenIds.map((tokenId) =>
      client.readContract({
        address: cfg.nfpm,
        abi: nfpmAbi,
        functionName: "positions",
        args: [tokenId],
      }),
    ),
  );

  return tokenIds.map((tokenId, i) => {
    const p = positions[i];
    return {
      positionId: tokenId.toString(),
      token0: p[2],
      token1: p[3],
      fee: p[4],
      tickLower: p[5],
      tickUpper: p[6],
      liquidity: p[7].toString(),
      tokensOwed0: p[10].toString(),
      tokensOwed1: p[11].toString(),
    };
  });
}

// ─── ERC-20 approve ──────────────────────────────────────────────────

export interface ApproveParams {
  chainId: number;
  token: Address;
  spender: Address;
  amount: bigint;
}

/** Encode an ERC-20 `approve(spender, amount)` call against `token`. */
export function buildApproveTx(params: ApproveParams): UnsignedTx {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [params.spender, params.amount],
  });
  return { to: params.token, data, value: "0", chainId: params.chainId };
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

/** Dry-runs `tx` via `eth_call` and returns its raw return data (`"0x"` for calls with no outputs). */
export async function simulateTx(
  chainId: number,
  tx: UnsignedTx,
  from: Address,
): Promise<Hex> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const { data } = await client.call({
    account: from,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
  });
  return data ?? "0x";
}

// ─── decode simulation return data ───────────────────────────────────
// Each decoder mirrors one NFPM/ERC-20 write function's `outputs`, turning the
// raw `eth_call` return data `simulateTx` produces into the actual amounts a
// caller wants to see (bigints as decimal strings, matching the rest of this
// module's JSON-facing types).

export interface CollectAmounts {
  amount0: string;
  amount1: string;
}

export function decodeCollectResult(data: Hex): CollectAmounts {
  const [amount0, amount1] = decodeFunctionResult({
    abi: nfpmAbi,
    functionName: "collect",
    data,
  });
  return { amount0: amount0.toString(), amount1: amount1.toString() };
}

export type DecreaseLiquidityAmounts = CollectAmounts;

export function decodeDecreaseLiquidityResult(data: Hex): DecreaseLiquidityAmounts {
  const [amount0, amount1] = decodeFunctionResult({
    abi: nfpmAbi,
    functionName: "decreaseLiquidity",
    data,
  });
  return { amount0: amount0.toString(), amount1: amount1.toString() };
}

export interface IncreaseLiquidityAmounts {
  liquidity: string;
  amount0: string;
  amount1: string;
}

export function decodeIncreaseLiquidityResult(data: Hex): IncreaseLiquidityAmounts {
  const [liquidity, amount0, amount1] = decodeFunctionResult({
    abi: nfpmAbi,
    functionName: "increaseLiquidity",
    data,
  });
  return {
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

export interface MintCallResult {
  tokenId: string;
  liquidity: string;
  amount0: string;
  amount1: string;
}

export function decodeMintResult(data: Hex): MintCallResult {
  const [tokenId, liquidity, amount0, amount1] = decodeFunctionResult({
    abi: nfpmAbi,
    functionName: "mint",
    data,
  });
  return {
    tokenId: tokenId.toString(),
    liquidity: liquidity.toString(),
    amount0: amount0.toString(),
    amount1: amount1.toString(),
  };
}

/** Unwraps a `multicall` return into its per-call raw return data, in call order. */
export function decodeMulticallResults(data: Hex): readonly Hex[] {
  return decodeFunctionResult({ abi: nfpmAbi, functionName: "multicall", data });
}

export function decodeApproveResult(data: Hex): boolean {
  return decodeFunctionResult({ abi: erc20Abi, functionName: "approve", data });
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
const CMD_PERMIT2_PERMIT = "0a";
const CMD_WRAP_ETH = "0b";
const CMD_UNWRAP_WETH = "0c";

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

// ─── Permit2 (signed AllowanceTransfer permit, embedded in a swap tx) ────────
//
// The default Permit2-paid swap path below needs a standing
// Permit2.allowance(owner, tokenIn, universalRouter) — normally set via an
// on-chain Permit2.approve(), a call many wallet policies don't allowlist.
// Universal Router's PERMIT2_PERMIT command lets a signed, single-swap-scoped
// PermitSingle be embedded ahead of the swap command instead: Permit2.permit()
// and the swap's own Permit2.transferFrom() land atomically in the same tx, so
// no separate approval tx — or wallet-policy carve-out for calling Permit2
// directly — is ever needed. Only a `sign_typed_data` capability scoped to the
// Permit2 verifying contract is required.

const PERMIT2_DOMAIN_NAME = "Permit2"; // Permit2's EIP-712 domain has no `version` field.
const PERMIT2_SIG_DEADLINE_SECS = 300; // the signature itself expires in 5 min if unused
const PERMIT2_EXPIRATION_SECS = 300; // the allowance it sets also expires in 5 min — single-swap scoped, not a standing grant
const PERMIT2_ALLOWANCE_SAFETY_MARGIN_SECS = 60; // don't treat a standing allowance as usable if it expires almost immediately

const PERMIT2_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
} as const;

export interface Permit2Details {
  token: Address;
  amount: string; // uint160 wei, decimal string (exceeds JS safe integers)
  expiration: number; // unix seconds
  nonce: number;
}

export interface Permit2Single {
  details: Permit2Details;
  spender: Address;
  sigDeadline: number; // unix seconds
}

export interface Permit2TypedData {
  domain: { name: string; chainId: number; verifyingContract: Address };
  types: typeof PERMIT2_TYPES;
  primaryType: "PermitSingle";
  message: Permit2Single;
}

function permit2Domain(chainId: number): Permit2TypedData["domain"] {
  const cfg = getChain(chainId);
  return { name: PERMIT2_DOMAIN_NAME, chainId, verifyingContract: cfg.permit2 };
}

// uint160 (`amount`)/uint256 (`sigDeadline`) decode as bigint; uint48
// (`expiration`/`nonce`) decode as plain `number` — mirrored here since
// `amount`/`sigDeadline` cross the MCP JSON boundary as decimal strings.
function toPermit2Message(permit: Permit2Single) {
  return {
    details: {
      token: permit.details.token,
      amount: BigInt(permit.details.amount),
      expiration: permit.details.expiration,
      nonce: permit.details.nonce,
    },
    spender: permit.spender,
    sigDeadline: BigInt(permit.sigDeadline),
  };
}

/** Reads Permit2's stored allowance state for (owner, token, spender) — `nonce` feeds the next `PermitSingle`. */
export async function getPermit2Allowance(
  chainId: number,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<{ amount: bigint; expiration: number; nonce: number }> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const [amount, expiration, nonce] = await client.readContract({
    address: cfg.permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender],
  });
  return { amount, expiration, nonce };
}

/** Builds a fresh, short-lived `PermitSingle` for `owner` to sign, plus its EIP-712 payload. */
function buildPermit2TypedData(
  chainId: number,
  token: Address,
  spender: Address,
  amount: bigint,
  nonce: number,
): { permit: Permit2Single; typedData: Permit2TypedData } {
  const now = Math.floor(Date.now() / 1000);
  const permit: Permit2Single = {
    details: {
      token,
      amount: amount.toString(),
      expiration: now + PERMIT2_EXPIRATION_SECS,
      nonce,
    },
    spender,
    sigDeadline: now + PERMIT2_SIG_DEADLINE_SECS,
  };
  return {
    permit,
    typedData: {
      domain: permit2Domain(chainId),
      types: PERMIT2_TYPES,
      primaryType: "PermitSingle",
      message: permit,
    },
  };
}

export interface Permit2Requirement {
  sufficient: boolean;
  permit?: Permit2Single;
  typedData?: Permit2TypedData;
}

/**
 * Checks whether Permit2 already has a standing allowance covering `amount`
 * of `token` for the chain's Universal Router; if not, returns a fresh
 * `PermitSingle` + EIP-712 payload for `owner` to sign — feed the signature
 * straight back into `buildSwapTx`'s `permit2`/`permit2Signature`.
 */
export async function checkPermit2Requirement(
  chainId: number,
  owner: Address,
  token: Address,
  amount: bigint,
): Promise<Permit2Requirement> {
  const cfg = getChain(chainId);
  const { amount: allowed, expiration, nonce } = await getPermit2Allowance(
    chainId,
    owner,
    token,
    cfg.universalRouter,
  );
  const now = Math.floor(Date.now() / 1000);
  if (allowed >= amount && expiration > now + PERMIT2_ALLOWANCE_SAFETY_MARGIN_SECS) {
    return { sufficient: true };
  }
  const { permit, typedData } = buildPermit2TypedData(
    chainId,
    token,
    cfg.universalRouter,
    amount,
    nonce,
  );
  return { sufficient: false, permit, typedData };
}

/** Verifies `signature` was produced by `owner` over `permit` — ecrecover for an EOA, falling back to ERC-1271 for a smart-contract wallet. */
export async function verifyPermit2Signature(
  chainId: number,
  owner: Address,
  permit: Permit2Single,
  signature: Hex,
): Promise<boolean> {
  const cfg = getChain(chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  return client.verifyTypedData({
    address: owner,
    domain: permit2Domain(chainId),
    types: PERMIT2_TYPES,
    primaryType: "PermitSingle",
    message: toPermit2Message(permit),
    signature,
  });
}

/** Encodes the `(PermitSingle, bytes signature)` tuple `PERMIT2_PERMIT` expects. */
function encodePermit2PermitInput(permit: Permit2Single, signature: Hex): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "details",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint160" },
              { name: "expiration", type: "uint48" },
              { name: "nonce", type: "uint48" },
            ],
          },
          { name: "spender", type: "address" },
          { name: "sigDeadline", type: "uint256" },
        ],
      },
      { type: "bytes" },
    ],
    [toPermit2Message(permit), signature],
  );
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
  tokenIn: Address;
  amountInWei: bigint;
  tokenOut: Address;
  fee: number; // pool fee tier for the tokenIn→tokenOut hop
  amountOutMin: bigint;
  recipient?: Address; // default: the tx sender (MSG_SENDER placeholder)
  /**
   * Wrap this much native ETH first (≥ amountInWei); the un-swapped remainder
   * is swept back to `recipient` as WETH. Requires `tokenIn` to be WETH9.
   * Omit when the wallet already holds `tokenIn` — that variant pays through
   * Permit2, so the wallet needs either a standing Permit2 allowance for
   * `tokenIn` or a signed `permit2`/`permit2Signature` (see below) rather than
   * a plain ERC-20 approval to the router.
   */
  wrapWei?: bigint;
  /**
   * Unwrap the swap output from WETH9 to native ETH before it reaches
   * `recipient`. Requires `tokenOut` to be WETH9. Mutually exclusive with
   * `wrapWei`.
   */
  unwrapOut?: boolean;
  /**
   * Embeds a signed Permit2 `PERMIT2_PERMIT` command before the swap command,
   * so the Universal Router's Permit2 allowance is set AND consumed
   * atomically in this tx — no standing on-chain allowance required. Get
   * `permit`/`typedData` from `checkPermit2Requirement` (surfaced by
   * `swapOp` as a `permit2Required` response when the allowance is
   * insufficient), sign `typedData`, then pass the same `permit` back here
   * verbatim together with the signature as `permit2Signature`. Mutually
   * exclusive with `wrapWei` (that path pays via WRAP_ETH, not Permit2).
   */
  permit2?: Permit2Single;
  permit2Signature?: Hex;
  deadline?: number; // unix seconds; default now + 20 min
}

/**
 * Exact-in single-hop v3 swap `tokenIn` → `tokenOut` via Universal Router.
 * With `wrapWei`: `WRAP_ETH(ADDRESS_THIS)` + `V3_SWAP_EXACT_IN(payerIsUser=
 * false)` + `SWEEP(WETH9, recipient, remainder)` in one payable tx — the
 * "wallet holds native ETH but the position needs WETH/ERC-20" path. With
 * `unwrapOut`: `V3_SWAP_EXACT_IN(recipient=router)` + `UNWRAP_WETH(recipient)`
 * — the "position holds an ERC-20 but the wallet wants native ETH" path.
 */
export function buildSwapTx(params: SwapParams): UnsignedTx {
  const cfg = getChain(params.chainId);
  const recipient = params.recipient ?? MSG_SENDER;
  const isWeth9 = (addr: Address) => addr.toLowerCase() === cfg.weth9.toLowerCase();
  const path = encodePacked(
    ["address", "uint24", "address"],
    [params.tokenIn, params.fee, params.tokenOut],
  );
  const swapInput = (swapRecipient: Address, payerIsUser: boolean) =>
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "bool" },
      ],
      [swapRecipient, params.amountInWei, params.amountOutMin, path, payerIsUser],
    );

  if (params.wrapWei !== undefined && params.unwrapOut) {
    throw new Error("wrapWei and unwrapOut cannot both be set");
  }
  if (params.wrapWei !== undefined && !isWeth9(params.tokenIn)) {
    throw new Error(`wrapWei requires tokenIn to be WETH9 (${cfg.weth9})`);
  }
  if (params.unwrapOut && !isWeth9(params.tokenOut)) {
    throw new Error(`unwrapOut requires tokenOut to be WETH9 (${cfg.weth9})`);
  }
  if ((params.permit2 === undefined) !== (params.permit2Signature === undefined)) {
    throw new Error("permit2 and permit2Signature must be provided together");
  }
  if (params.permit2 !== undefined && params.wrapWei !== undefined) {
    throw new Error(
      "permit2 cannot be combined with wrapWei — that path pays via WRAP_ETH, not Permit2",
    );
  }
  if (params.permit2 !== undefined) {
    if (params.permit2.details.token.toLowerCase() !== params.tokenIn.toLowerCase()) {
      throw new Error("permit2.details.token must match tokenIn");
    }
    if (params.permit2.spender.toLowerCase() !== cfg.universalRouter.toLowerCase()) {
      throw new Error("permit2.spender must be this chain's Universal Router");
    }
    if (BigInt(params.permit2.details.amount) !== params.amountInWei) {
      throw new Error("permit2.details.amount must equal amountInWei");
    }
  }

  const permit2Command = params.permit2 !== undefined ? CMD_PERMIT2_PERMIT : "";
  const permit2Inputs =
    params.permit2 !== undefined
      ? [encodePermit2PermitInput(params.permit2, params.permit2Signature as Hex)]
      : [];

  if (params.unwrapOut) {
    const unwrapInput = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [recipient, params.amountOutMin],
    );
    return urExecute(
      params.chainId,
      `0x${permit2Command}${CMD_V3_SWAP_EXACT_IN}${CMD_UNWRAP_WETH}`,
      [...permit2Inputs, swapInput(ADDRESS_THIS, true), unwrapInput],
      0n,
      params.deadline,
    );
  }

  if (params.wrapWei === undefined) {
    return urExecute(
      params.chainId,
      `0x${permit2Command}${CMD_V3_SWAP_EXACT_IN}`,
      [...permit2Inputs, swapInput(recipient, true)],
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
    [wrapInput, swapInput(recipient, false), sweepInput],
    params.wrapWei,
    params.deadline,
  );
}

// ─── QuoterV2 (off-chain swap quoting, no tx) ────────────────────────

export interface QuoteSwapParams {
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountInWei: bigint;
  fee: number; // pool fee tier for the tokenIn→tokenOut hop
  slippageBps?: number;
}

export interface QuoteSwapResult {
  amountOut: string; // wei, as reported by the pool at its current price
  amountOutMin: string; // amountOut after slippageBps (default 0.5%) — feeds build_swap
  sqrtPriceX96After: string;
  initializedTicksCrossed: number;
  gasEstimate: string;
}

/**
 * Quote an exact-in single-hop `tokenIn` → `tokenOut` swap via QuoterV2 —
 * the live price a `build_swap` with the same params would execute at,
 * without sending a tx. Call this right before `build_swap` and feed
 * `amountOutMin` straight in; a quote read even a block earlier can be stale
 * enough to make that `amountOutMin` revert the swap.
 */
export async function getSwapQuote(
  params: QuoteSwapParams,
): Promise<QuoteSwapResult> {
  const cfg = getChain(params.chainId);
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });

  const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] =
    await client.readContract({
      address: cfg.quoterV2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInWei,
          fee: params.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

  return {
    amountOut: amountOut.toString(),
    amountOutMin: minWithSlippage(amountOut, params.slippageBps).toString(),
    sqrtPriceX96After: sqrtPriceX96After.toString(),
    initializedTicksCrossed,
    gasEstimate: gasEstimate.toString(),
  };
}
