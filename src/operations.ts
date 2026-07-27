/**
 * Operation layer — the code path behind the MCP tools in `mcp.ts`, kept
 * separate from transport so it stays unit-testable and ready to host a second
 * (e.g. Uniswap v4) tool set. Each op builds an unsigned tx, optionally
 * dry-runs it via `eth_call`, and returns a JSON-serializable payload. A failed
 * simulation throws {@link SimulationError} so a caller can distinguish a
 * reverted dry-run from a malformed request.
 */
import { type Address, type Hex, maxUint256 } from "viem";

import {
  type ApproveParams,
  type CollectAmounts,
  type OwnedPosition,
  type Permit2Single,
  type Permit2TypedData,
  type PlanPositionParams,
  type PlanPositionResult,
  type PoolStateParams,
  type PoolStateResult,
  type QuoteSwapParams,
  type QuoteSwapResult,
  type SwapParams,
  type UnsignedTx,
  type WrapParams,
  buildApproveTx,
  buildCloseTx,
  buildCollectTx,
  buildIncreaseLiquidityTx,
  buildMintTx,
  buildSwapTx,
  buildWrapTx,
  checkPermit2Requirement,
  decodeApproveResult,
  decodeCollectResult,
  decodeDecreaseLiquidityResult,
  decodeIncreaseLiquidityResult,
  decodeMintResult,
  decodeMulticallResults,
  getPoolState,
  getPositionsByOwner,
  getSwapQuote,
  planPosition,
  simulateTx,
  toUnsignedRlp,
  verifyPermit2Signature,
} from "./builder.js";

/** Thrown when the opt-in `eth_call` dry-run reverts — never sign such a tx. */
export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationError";
  }
}

export interface TxResult {
  tx: UnsignedTx;
  /** Unsigned EIP-1559 serialization of `tx` (nonce/fees/gas zeroed). */
  rlp: string;
  simulated: boolean;
  /** Decoded `eth_call` return value, when `simulated` and the call has one. */
  simulationResult?: unknown;
  description: string;
}

interface SimOutcome<T> {
  simulated: boolean;
  simulationResult?: T;
}

async function maybeSimulate<T>(
  chainId: number,
  tx: UnsignedTx,
  from: Address,
  simulate: boolean,
  decode: (data: Hex) => T,
): Promise<SimOutcome<T>> {
  if (!simulate) return { simulated: false };
  let data: Hex;
  try {
    data = await simulateTx(chainId, tx, from);
  } catch (err) {
    throw new SimulationError(err instanceof Error ? err.message : String(err));
  }
  return { simulated: true, simulationResult: decode(data) };
}

export interface CollectArgs {
  chainId: number;
  positionId: bigint;
  recipient: Address;
  simulate?: boolean; // default true
}

export async function collectOp(args: CollectArgs): Promise<TxResult> {
  const tx = await buildCollectTx(args.chainId, args.positionId, args.recipient);
  const { simulated, simulationResult } = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate !== false,
    decodeCollectResult,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    simulationResult,
    description: `Collect fees from position #${args.positionId}`,
  };
}

export interface CloseArgs {
  chainId: number;
  positionId: bigint;
  recipient: Address;
  burn?: boolean; // default false
  simulate?: boolean; // default true
}

export interface CloseResult extends TxResult {
  position: {
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: string;
  };
}

export interface CloseCallResult {
  decreaseLiquidity?: CollectAmounts;
  collect: CollectAmounts;
}

/**
 * `buildCloseTx` sends `collect` directly when it's the only call, otherwise
 * wraps `[decreaseLiquidity?, collect]` in a `multicall` — decoding has to
 * mirror that same shape to line results up with the calls that produced them.
 */
function decodeCloseResult(
  data: Hex,
  hadDecrease: boolean,
  hadBurn: boolean,
): CloseCallResult {
  if (!hadDecrease && !hadBurn) {
    return { collect: decodeCollectResult(data) };
  }
  const results = decodeMulticallResults(data);
  if (!hadDecrease) {
    return { collect: decodeCollectResult(results[0]) };
  }
  return {
    decreaseLiquidity: decodeDecreaseLiquidityResult(results[0]),
    collect: decodeCollectResult(results[1]),
  };
}

export async function closeOp(args: CloseArgs): Promise<CloseResult> {
  const { tx, position } = await buildCloseTx(
    args.chainId,
    args.positionId,
    args.recipient,
    args.burn ?? false,
  );
  const hadDecrease = position.liquidity > 0n;
  const hadBurn = args.burn ?? false;
  const { simulated, simulationResult } = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate !== false,
    (data) => decodeCloseResult(data, hadDecrease, hadBurn),
  );

  const action = position.liquidity > 0n
    ? "Close position"
    : "Collect remaining tokens from position";
  const suffix = args.burn ? " + burn NFT" : "";

  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    simulationResult,
    position: {
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity.toString(),
    },
    description: `${action} #${args.positionId}${suffix}`,
  };
}

export interface MintArgs {
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
  simulate?: boolean; // default false (minting needs approvals + balances)
}

export async function mintOp(args: MintArgs): Promise<TxResult> {
  const tx = buildMintTx(args);
  const { simulated, simulationResult } = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate === true,
    decodeMintResult,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    simulationResult,
    description: `Mint new position: ${args.token0}/${args.token1} fee=${args.fee} range=[${args.tickLower}, ${args.tickUpper}]`,
  };
}

export interface IncreaseArgs {
  chainId: number;
  positionId: bigint;
  amount0Desired: bigint;
  amount1Desired: bigint;
  recipient: Address; // simulation `from`
  slippageBps?: number;
  simulate?: boolean; // default false (needs approvals + balances)
}

export async function increaseOp(args: IncreaseArgs): Promise<TxResult> {
  const tx = buildIncreaseLiquidityTx(args);
  const { simulated, simulationResult } = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate === true,
    decodeIncreaseLiquidityResult,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    simulationResult,
    description: `Increase liquidity of position #${args.positionId}`,
  };
}

export async function planOp(
  args: PlanPositionParams,
): Promise<PlanPositionResult> {
  return planPosition(args);
}

export async function poolStateOp(
  args: PoolStateParams,
): Promise<PoolStateResult> {
  return getPoolState(args);
}

export interface PositionsArgs {
  chainId: number;
  owner: Address;
}

export interface PositionsResult {
  owner: Address;
  positions: OwnedPosition[];
}

export async function positionsOp(args: PositionsArgs): Promise<PositionsResult> {
  const positions = await getPositionsByOwner(args.chainId, args.owner);
  return { owner: args.owner, positions };
}

// Wrap/swap txs are payable and spend the sender's native ETH, so simulation
// needs the actual signer as `from` — `sender` opts it in (unlike collect/
// close, where `recipient` doubles as a plausible `from`).
async function maybeSimulateAsSender<T>(
  chainId: number,
  tx: UnsignedTx,
  sender: Address | undefined,
  simulate: boolean | undefined,
  decode: (data: Hex) => T,
): Promise<SimOutcome<T>> {
  if (!sender) {
    if (simulate === true) {
      throw new Error("simulate: true requires `sender` (the wallet that will sign)");
    }
    return { simulated: false };
  }
  return maybeSimulate(chainId, tx, sender, simulate !== false, decode);
}

export interface WrapArgs extends WrapParams {
  sender?: Address; // simulation `from`; must hold the ETH being wrapped
  simulate?: boolean; // default: on when `sender` is provided
}

// Universal Router's `execute` has no outputs — nothing to decode from a
// wrap/swap dry-run beyond whether it reverted.
const noDecode = () => undefined;

export async function wrapOp(args: WrapArgs): Promise<TxResult> {
  const tx = buildWrapTx(args);
  const { simulated } = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
    noDecode,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    description: `Wrap ${args.amountWei} wei native ETH to WETH via Universal Router`,
  };
}

export async function quoteSwapOp(
  args: QuoteSwapParams,
): Promise<QuoteSwapResult> {
  return getSwapQuote(args);
}

export interface SwapArgs extends SwapParams {
  sender?: Address; // simulation `from`; must hold the ETH/WETH being swapped
  simulate?: boolean; // default: on when `sender` is provided
}

/**
 * Returned instead of a tx when the default (non-`wrapWei`) Permit2-paid path
 * has no standing on-chain allowance covering the swap: sign `typedData` with
 * `sender` (e.g. via a wallet's `sign_typed_data`), then call `build_swap`
 * again with the same args plus `permit2: permit` and `permit2Signature` — no
 * separate on-chain Permit2 approval tx needed.
 */
export interface Permit2SignRequest {
  permit2Required: true;
  typedData: Permit2TypedData;
  permit: Permit2Single;
  description: string;
}

export type SwapResult = TxResult | Permit2SignRequest;

export async function swapOp(args: SwapArgs): Promise<SwapResult> {
  // Only the default Permit2-paid path (no wrapWei) needs an allowance;
  // skip auto-detection once a permit is already supplied or without a
  // `sender` to check the allowance for.
  if (args.wrapWei === undefined && args.permit2 === undefined && args.sender !== undefined) {
    const requirement = await checkPermit2Requirement(
      args.chainId,
      args.sender,
      args.tokenIn,
      args.amountInWei,
    );
    if (!requirement.sufficient) {
      return {
        permit2Required: true,
        typedData: requirement.typedData as Permit2TypedData,
        permit: requirement.permit as Permit2Single,
        description:
          `No sufficient Permit2 allowance for the Universal Router to pull ` +
          `${args.amountInWei} wei of ${args.tokenIn} from ${args.sender}. Sign ` +
          `\`typedData\` with that wallet, then call build_swap again with the ` +
          `same args plus permit2=<this "permit"> and permit2Signature=<the ` +
          `signature> — no on-chain approval tx needed.`,
      };
    }
  }

  if (args.permit2 !== undefined && args.permit2Signature !== undefined && args.sender !== undefined) {
    const valid = await verifyPermit2Signature(
      args.chainId,
      args.sender,
      args.permit2,
      args.permit2Signature,
    );
    if (!valid) {
      throw new Error(
        "permit2Signature does not match permit2 for `sender` — re-sign the exact " +
          "typedData from the build_swap call that returned this permit.",
      );
    }
  }

  const tx = buildSwapTx(args);
  const { simulated } = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
    noDecode,
  );
  const swapOut = args.unwrapOut ? "native ETH" : args.tokenOut;
  const swap = `swap ${args.amountInWei} wei ${args.tokenIn} → ${swapOut} (fee ${args.fee})`;
  let description: string;
  if (args.wrapWei !== undefined) {
    description = `Universal Router: wrap ${args.wrapWei} wei native ETH, ${swap}, sweep WETH remainder`;
  } else if (args.unwrapOut) {
    description = `Universal Router: ${swap}, unwrap WETH to native ETH`;
  } else {
    description = `Universal Router: ${swap}`;
  }
  if (args.permit2 !== undefined) {
    description += " (Permit2 permit embedded — no standing allowance required)";
  }
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    description,
  };
}

export interface ApproveArgs extends ApproveParams {
  sender?: Address; // simulation `from`; must be the token holder granting the allowance
  simulate?: boolean; // default: on when `sender` is provided
}

export async function approveOp(args: ApproveArgs): Promise<TxResult> {
  const tx = buildApproveTx(args);
  const { simulated, simulationResult } = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
    (data) => ({ approved: decodeApproveResult(data) }),
  );
  const amount = args.amount === maxUint256 ? "unlimited" : `${args.amount} wei`;
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    simulationResult,
    description: `Approve ${args.spender} to spend ${amount} of ${args.token}`,
  };
}
