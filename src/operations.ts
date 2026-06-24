/**
 * Operation layer — the code path behind the MCP tools in `mcp.ts`, kept
 * separate from transport so it stays unit-testable and ready to host a second
 * (e.g. Uniswap v4) tool set. Each op builds an unsigned tx, optionally
 * dry-runs it via `eth_call`, and returns a JSON-serializable payload. A failed
 * simulation throws {@link SimulationError} so a caller can distinguish a
 * reverted dry-run from a malformed request.
 */
import type { Address } from "viem";

import {
  type PlanPositionParams,
  type PlanPositionResult,
  type UnsignedTx,
  buildCloseTx,
  buildCollectTx,
  buildIncreaseLiquidityTx,
  buildMintTx,
  planPosition,
  simulateTx,
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
    simulated,
    description: `Increase liquidity of position #${args.positionId}`,
  };
}

export async function planOp(
  args: PlanPositionParams,
): Promise<PlanPositionResult> {
  return planPosition(args);
}
