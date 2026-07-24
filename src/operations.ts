/**
 * Operation layer — the code path behind the MCP tools in `mcp.ts`, kept
 * separate from transport so it stays unit-testable and ready to host a second
 * (e.g. Uniswap v4) tool set. Each op builds an unsigned tx, optionally
 * dry-runs it via `eth_call`, and returns a JSON-serializable payload. A failed
 * simulation throws {@link SimulationError} so a caller can distinguish a
 * reverted dry-run from a malformed request.
 */
import { type Address, maxUint256 } from "viem";

import {
  type ApproveParams,
  type OwnedPosition,
  type PlanPositionParams,
  type PlanPositionResult,
  type PoolStateParams,
  type PoolStateResult,
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
  getPoolState,
  getPositionsByOwner,
  planPosition,
  simulateTx,
  toUnsignedRlp,
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
  description: string;
}

async function maybeSimulate(
  chainId: number,
  tx: UnsignedTx,
  from: Address,
  simulate: boolean,
): Promise<boolean> {
  if (!simulate) return false;
  try {
    await simulateTx(chainId, tx, from);
  } catch (err) {
    throw new SimulationError(err instanceof Error ? err.message : String(err));
  }
  return true;
}

export interface CollectArgs {
  chainId: number;
  positionId: bigint;
  recipient: Address;
  simulate?: boolean; // default true
}

export async function collectOp(args: CollectArgs): Promise<TxResult> {
  const tx = await buildCollectTx(args.chainId, args.positionId, args.recipient);
  const simulated = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate !== false,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
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

export async function closeOp(args: CloseArgs): Promise<CloseResult> {
  const { tx, position } = await buildCloseTx(
    args.chainId,
    args.positionId,
    args.recipient,
    args.burn ?? false,
  );
  const simulated = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate !== false,
  );

  const action = position.liquidity > 0n
    ? "Close position"
    : "Collect remaining tokens from position";
  const suffix = args.burn ? " + burn NFT" : "";

  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
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
  const simulated = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate === true,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
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
  const simulated = await maybeSimulate(
    args.chainId,
    tx,
    args.recipient,
    args.simulate === true,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
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
async function maybeSimulateAsSender(
  chainId: number,
  tx: UnsignedTx,
  sender: Address | undefined,
  simulate: boolean | undefined,
): Promise<boolean> {
  if (!sender) {
    if (simulate === true) {
      throw new Error("simulate: true requires `sender` (the wallet that will sign)");
    }
    return false;
  }
  return maybeSimulate(chainId, tx, sender, simulate !== false);
}

export interface WrapArgs extends WrapParams {
  sender?: Address; // simulation `from`; must hold the ETH being wrapped
  simulate?: boolean; // default: on when `sender` is provided
}

export async function wrapOp(args: WrapArgs): Promise<TxResult> {
  const tx = buildWrapTx(args);
  const simulated = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
  );
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    description: `Wrap ${args.amountWei} wei native ETH to WETH via Universal Router`,
  };
}

export interface SwapArgs extends SwapParams {
  sender?: Address; // simulation `from`; must hold the ETH/WETH being swapped
  simulate?: boolean; // default: on when `sender` is provided
}

export async function swapOp(args: SwapArgs): Promise<TxResult> {
  const tx = buildSwapTx(args);
  const simulated = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
  );
  const swap = `swap ${args.amountInWei} wei WETH → ${args.tokenOut} (fee ${args.fee})`;
  const description =
    args.wrapWei === undefined
      ? `Universal Router: ${swap}`
      : `Universal Router: wrap ${args.wrapWei} wei native ETH, ${swap}, sweep WETH remainder`;
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
  const simulated = await maybeSimulateAsSender(
    args.chainId,
    tx,
    args.sender,
    args.simulate,
  );
  const amount = args.amount === maxUint256 ? "unlimited" : `${args.amount} wei`;
  return {
    tx,
    rlp: toUnsignedRlp(tx),
    simulated,
    description: `Approve ${args.spender} to spend ${amount} of ${args.token}`,
  };
}
