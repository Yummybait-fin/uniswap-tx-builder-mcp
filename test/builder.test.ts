import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";

import { erc20Abi, nfpmAbi } from "../src/abi.js";

// ── mock viem's createPublicClient (used by readPosition) ────────────

const mockReadContract = vi.fn();
const mockCall = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
      call: mockCall,
    }),
  };
});

import {
  buildApproveTx,
  buildCloseTx,
  buildCollectTx,
  buildIncreaseLiquidityTx,
  buildMintTx,
  getPoolState,
  getPositionsByOwner,
  planPosition,
  simulateTx,
} from "../src/builder.js";
import { computeMintAmounts } from "../src/ticks.js";

// ── constants ────────────────────────────────────────────────────────

const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;
const TOKEN0 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const TOKEN1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const ETH_NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const BASE_NFPM = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";

// Fix time for deterministic deadline checks
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── buildCollectTx ───────────────────────────────────────────────────

describe("buildCollectTx", () => {
  it("encodes a collect call with correct parameters", async () => {
    const tx = await buildCollectTx(1, 12345n, RECIPIENT);

    expect(tx.to).toBe(ETH_NFPM);
    expect(tx.chainId).toBe(1);
    expect(tx.value).toBe("0");
    expect(tx.data).toMatch(/^0x[a-f0-9]+$/i);

    const decoded = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(decoded.functionName).toBe("collect");
    expect(decoded.args[0].tokenId).toBe(12345n);
    expect(decoded.args[0].recipient.toLowerCase()).toBe(
      RECIPIENT.toLowerCase(),
    );
    // amount0Max and amount1Max should be MAX_UINT128
    const MAX_UINT128 = (1n << 128n) - 1n;
    expect(decoded.args[0].amount0Max).toBe(MAX_UINT128);
    expect(decoded.args[0].amount1Max).toBe(MAX_UINT128);
  });

  it("uses Base NFPM for chain 8453", async () => {
    const tx = await buildCollectTx(8453, 100n, RECIPIENT);
    expect(tx.to).toBe(BASE_NFPM);
    expect(tx.chainId).toBe(8453);
  });

  it("rejects unsupported chain", async () => {
    await expect(buildCollectTx(999, 1n, RECIPIENT)).rejects.toThrow(
      "Unsupported chain",
    );
  });
});

// ── buildMintTx ──────────────────────────────────────────────────────

describe("buildMintTx", () => {
  it("encodes mint with default 0.5% slippage", () => {
    const tx = buildMintTx({
      chainId: 1,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired: 1_000_000n,
      amount1Desired: 500_000_000_000_000_000n,
      recipient: RECIPIENT,
    });

    expect(tx.to).toBe(ETH_NFPM);
    expect(tx.chainId).toBe(1);
    expect(tx.value).toBe("0");

    const decoded = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(decoded.functionName).toBe("mint");

    const p = decoded.args[0];
    expect(p.token0.toLowerCase()).toBe(TOKEN0.toLowerCase());
    expect(p.token1.toLowerCase()).toBe(TOKEN1.toLowerCase());
    expect(p.fee).toBe(3000);
    expect(p.tickLower).toBe(-887220);
    expect(p.tickUpper).toBe(887220);
    expect(p.amount0Desired).toBe(1_000_000n);
    expect(p.amount1Desired).toBe(500_000_000_000_000_000n);

    // 0.5% slippage: 1_000_000 - 1_000_000 * 50 / 10000 = 995_000
    expect(p.amount0Min).toBe(995_000n);
    // 500_000_000_000_000_000 * 50 / 10000 = 2_500_000_000_000_000
    expect(p.amount1Min).toBe(497_500_000_000_000_000n);

    // Deadline = now + 1800s
    const expectedDeadline = BigInt(
      Math.floor(new Date("2026-01-15T12:00:00Z").getTime() / 1000) + 1800,
    );
    expect(p.deadline).toBe(expectedDeadline);
  });

  it("applies custom slippage (1%)", () => {
    const tx = buildMintTx({
      chainId: 1,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 500,
      tickLower: -1000,
      tickUpper: 1000,
      amount0Desired: 10_000n,
      amount1Desired: 10_000n,
      recipient: RECIPIENT,
      slippageBps: 100,
    });

    const decoded = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    const p = decoded.args[0];
    // 1% of 10_000 = 100 → min = 9_900
    expect(p.amount0Min).toBe(9_900n);
    expect(p.amount1Min).toBe(9_900n);
  });
});

// ── buildCloseTx ─────────────────────────────────────────────────────

describe("buildCloseTx", () => {
  const positionTuple = [
    0n, // nonce
    "0x0000000000000000000000000000000000000000", // operator
    TOKEN0,
    TOKEN1,
    3000, // fee
    -887220, // tickLower
    887220, // tickUpper
    1_000_000_000_000_000_000n, // liquidity (1e18)
    0n,
    0n,
    0n,
    0n,
  ] as const;

  it("encodes multicall(decreaseLiquidity + collect) when liquidity > 0", async () => {
    mockReadContract.mockResolvedValueOnce(positionTuple);

    const { tx, position } = await buildCloseTx(1, 42n, RECIPIENT);

    expect(tx.to).toBe(ETH_NFPM);
    expect(tx.chainId).toBe(1);
    expect(tx.value).toBe("0");

    // Position info should be extracted correctly
    expect(position.token0.toLowerCase()).toBe(TOKEN0.toLowerCase());
    expect(position.token1.toLowerCase()).toBe(TOKEN1.toLowerCase());
    expect(position.fee).toBe(3000);
    expect(position.liquidity).toBe(1_000_000_000_000_000_000n);

    // Outer call is multicall
    const outer = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    const innerCalls = outer.args[0];
    expect(innerCalls).toHaveLength(2);

    // First inner call: decreaseLiquidity
    const dl = decodeFunctionData({ abi: nfpmAbi, data: innerCalls[0] });
    expect(dl.functionName).toBe("decreaseLiquidity");
    expect(dl.args[0].tokenId).toBe(42n);
    expect(dl.args[0].liquidity).toBe(1_000_000_000_000_000_000n);
    expect(dl.args[0].amount0Min).toBe(0n);
    expect(dl.args[0].amount1Min).toBe(0n);

    // Second inner call: collect
    const col = decodeFunctionData({ abi: nfpmAbi, data: innerCalls[1] });
    expect(col.functionName).toBe("collect");
    expect(col.args[0].tokenId).toBe(42n);
    expect(col.args[0].recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("encodes only collect (no multicall) when liquidity is 0", async () => {
    const zeroLiq = [...positionTuple] as unknown as typeof positionTuple;
    // Replace liquidity (index 7) with 0
    (zeroLiq as unknown[])[7] = 0n;
    mockReadContract.mockResolvedValueOnce(zeroLiq);

    const { tx, position } = await buildCloseTx(1, 99n, RECIPIENT);

    expect(position.liquidity).toBe(0n);

    // Should be a direct collect, not wrapped in multicall
    const decoded = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(decoded.functionName).toBe("collect");
    expect(decoded.args[0].tokenId).toBe(99n);
  });

  it("appends burn to the multicall when burn=true", async () => {
    mockReadContract.mockResolvedValueOnce(positionTuple);

    const { tx } = await buildCloseTx(1, 42n, RECIPIENT, true);

    const outer = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    const innerCalls = outer.args[0];
    expect(innerCalls).toHaveLength(3);

    const fns = innerCalls.map(
      (c: `0x${string}`) => decodeFunctionData({ abi: nfpmAbi, data: c }).functionName,
    );
    expect(fns).toEqual(["decreaseLiquidity", "collect", "burn"]);

    const burnCall = decodeFunctionData({ abi: nfpmAbi, data: innerCalls[2] });
    expect(burnCall.args[0]).toBe(42n);
  });

  it("burns a zero-liquidity position via multicall(collect + burn)", async () => {
    const zeroLiq = [...positionTuple] as unknown as typeof positionTuple;
    (zeroLiq as unknown[])[7] = 0n;
    mockReadContract.mockResolvedValueOnce(zeroLiq);

    const { tx } = await buildCloseTx(1, 99n, RECIPIENT, true);

    const outer = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    const fns = outer.args[0].map(
      (c: `0x${string}`) => decodeFunctionData({ abi: nfpmAbi, data: c }).functionName,
    );
    expect(fns).toEqual(["collect", "burn"]);
  });
});

// ── buildIncreaseLiquidityTx ─────────────────────────────────────────

describe("buildIncreaseLiquidityTx", () => {
  it("encodes increaseLiquidity with slippage-derived mins", () => {
    const tx = buildIncreaseLiquidityTx({
      chainId: 1,
      positionId: 7n,
      amount0Desired: 1_000_000n,
      amount1Desired: 2_000_000n,
      slippageBps: 100, // 1%
    });

    expect(tx.to).toBe(ETH_NFPM);
    expect(tx.value).toBe("0");

    const decoded = decodeFunctionData({ abi: nfpmAbi, data: tx.data });
    expect(decoded.functionName).toBe("increaseLiquidity");
    const p = decoded.args[0];
    expect(p.tokenId).toBe(7n);
    expect(p.amount0Desired).toBe(1_000_000n);
    expect(p.amount1Desired).toBe(2_000_000n);
    expect(p.amount0Min).toBe(990_000n); // 1% off
    expect(p.amount1Min).toBe(1_980_000n);
  });

  it("defaults to 0.5% slippage", () => {
    const tx = buildIncreaseLiquidityTx({
      chainId: 1,
      positionId: 1n,
      amount0Desired: 10_000n,
      amount1Desired: 10_000n,
    });
    const p = decodeFunctionData({ abi: nfpmAbi, data: tx.data }).args[0];
    expect(p.amount0Min).toBe(9_950n);
  });
});

// ── buildApproveTx ─────────────────────────────────────────────────

describe("buildApproveTx", () => {
  it("encodes an ERC-20 approve call against the token address", () => {
    const tx = buildApproveTx({
      chainId: 1,
      token: TOKEN0,
      spender: TOKEN1,
      amount: 1_000_000n,
    });

    expect(tx.to).toBe(TOKEN0);
    expect(tx.chainId).toBe(1);
    expect(tx.value).toBe("0");

    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args[0].toLowerCase()).toBe(TOKEN1.toLowerCase());
    expect(decoded.args[1]).toBe(1_000_000n);
  });

  it("encodes a max (unlimited) allowance", () => {
    const maxUint256 = (1n << 256n) - 1n;
    const tx = buildApproveTx({
      chainId: 1,
      token: TOKEN0,
      spender: TOKEN1,
      amount: maxUint256,
    });
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    expect(decoded.args[1]).toBe(maxUint256);
  });
});

// ── getPositionsByOwner ────────────────────────────────────────────

describe("getPositionsByOwner", () => {
  beforeEach(() => {
    mockReadContract.mockClear();
  });

  const positionTuple = (tokenId: bigint) =>
    [
      0n,
      "0x0000000000000000000000000000000000000000",
      TOKEN0,
      TOKEN1,
      3000,
      -887220,
      887220,
      1_000_000_000_000_000_000n + tokenId,
      0n,
      0n,
      5n,
      6n,
    ] as const;

  it("returns no positions for a wallet holding none", async () => {
    mockReadContract.mockResolvedValueOnce(0n); // balanceOf

    const positions = await getPositionsByOwner(1, RECIPIENT);

    expect(positions).toEqual([]);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });

  it("enumerates every owned tokenId and reads its full position state", async () => {
    mockReadContract
      .mockResolvedValueOnce(2n) // balanceOf
      .mockResolvedValueOnce(10n) // tokenOfOwnerByIndex(0)
      .mockResolvedValueOnce(11n) // tokenOfOwnerByIndex(1)
      .mockResolvedValueOnce(positionTuple(10n)) // positions(10)
      .mockResolvedValueOnce(positionTuple(11n)); // positions(11)

    const positions = await getPositionsByOwner(1, RECIPIENT);

    expect(positions).toHaveLength(2);
    expect(positions[0]).toEqual({
      positionId: "10",
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: (1_000_000_000_000_000_000n + 10n).toString(),
      tokensOwed0: "5",
      tokensOwed1: "6",
    });
    expect(positions[1].positionId).toBe("11");
  });
});

// ── planPosition ─────────────────────────────────────────────────────

describe("planPosition", () => {
  // TOKEN0 (0xA0b8…) < TOKEN1 (0xC02a…) by address — valid ordering.
  it("converts a price range to aligned ticks and amounts to wei", async () => {
    mockReadContract
      .mockResolvedValueOnce(6) // token0 decimals (USDC-like)
      .mockResolvedValueOnce(18); // token1 decimals (WETH-like)

    const result = await planPosition({
      chainId: 1,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 3000, // tick spacing 60
      priceLower: 0.0003,
      priceUpper: 0.0005,
      amount0: "100", // 100 USDC
      amount1: "0.05", // 0.05 WETH
    });

    expect(result.tickSpacing).toBe(60);
    expect(result.decimals0).toBe(6);
    expect(result.decimals1).toBe(18);
    // Aligned to spacing and ordered low < high.
    expect(result.tickLower % 60).toBe(0);
    expect(result.tickUpper % 60).toBe(0);
    expect(result.tickLower).toBeLessThan(result.tickUpper);
    // parseUnits with the read decimals.
    expect(result.amount0Desired).toBe("100000000"); // 100 * 1e6
    expect(result.amount1Desired).toBe("50000000000000000"); // 0.05 * 1e18
  });

  it("rejects an unsorted token pair", async () => {
    await expect(
      planPosition({
        chainId: 1,
        token0: TOKEN1, // > TOKEN0 → invalid
        token1: TOKEN0,
        fee: 3000,
        priceLower: 1,
        priceUpper: 2,
      }),
    ).rejects.toThrow("token0 must be < token1");
  });
});

// ── simulateTx ───────────────────────────────────────────────────────

describe("simulateTx", () => {
  it("resolves when eth_call succeeds", async () => {
    const tx = await buildCollectTx(1, 1n, RECIPIENT);
    mockCall.mockResolvedValueOnce({ data: "0x" });

    await expect(simulateTx(1, tx, RECIPIENT)).resolves.toBeUndefined();

    expect(mockCall).toHaveBeenCalledWith(
      expect.objectContaining({
        account: RECIPIENT,
        to: ETH_NFPM,
        data: tx.data,
        value: 0n,
      }),
    );
  });

  it("throws when eth_call reverts", async () => {
    const tx = await buildCollectTx(1, 1n, RECIPIENT);
    mockCall.mockRejectedValueOnce(
      new Error("execution reverted: Not approved"),
    );

    await expect(simulateTx(1, tx, RECIPIENT)).rejects.toThrow(
      "Not approved",
    );
  });
});

// ── getPoolState ─────────────────────────────────────────────────────

describe("getPoolState", () => {
  beforeEach(() => {
    mockReadContract.mockClear();
  });

  const POOL = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8" as const;
  const Q96 = 1n << 96n;
  // sqrtPriceX96 = Q96 → raw ratio 1 → tick 0.
  const SLOT0 = [Q96, 0, 0, 0, 0, 0, true];

  /** Queue the four RPC reads getPoolState performs, in call order. */
  function mockPoolReads() {
    mockReadContract
      .mockResolvedValueOnce(POOL) // factory.getPool
      .mockResolvedValueOnce(SLOT0) // pool.slot0
      .mockResolvedValueOnce(60) // pool.tickSpacing
      .mockResolvedValueOnce(6) // token0.decimals (USDC-like)
      .mockResolvedValueOnce(18); // token1.decimals (WETH-like)
  }

  const BASE_PARAMS = {
    chainId: 1,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
  };

  it("returns live pool state", async () => {
    mockPoolReads();
    const state = await getPoolState(BASE_PARAMS);

    expect(state.pool).toBe(POOL);
    expect(state.tick).toBe(0);
    expect(state.tickSpacing).toBe(60);
    expect(state.sqrtPriceX96).toBe(Q96.toString());
    // ratio 1 in raw units → 10^(6-18) in human units
    expect(state.price).toBeCloseTo(1e-12, 15);
    expect(state.decimals0).toBe(6);
    expect(state.decimals1).toBe(18);
    expect(state.suggested).toBeUndefined();
    expect(state.mintAmounts).toBeUndefined();
  });

  it("rejects unsorted token pair without touching RPC", async () => {
    await expect(
      getPoolState({ ...BASE_PARAMS, token0: TOKEN1, token1: TOKEN0 }),
    ).rejects.toThrow("token0 must be < token1");
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("rejects a partial mint-amounts request without touching RPC", async () => {
    await expect(
      getPoolState({ ...BASE_PARAMS, balance0: 1n }),
    ).rejects.toThrow("Mint amounts need all of");
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("throws when the pool does not exist", async () => {
    mockReadContract.mockResolvedValueOnce(
      "0x0000000000000000000000000000000000000000",
    );
    await expect(getPoolState(BASE_PARAMS)).rejects.toThrow("No pool for");
  });

  it("suggests an aligned range for rangePct", async () => {
    mockPoolReads();
    const state = await getPoolState({ ...BASE_PARAMS, rangePct: 5 });

    // ±5% around tick 0 is ±487.9 ticks, rounded inward to spacing 60.
    expect(state.suggested).toEqual(
      expect.objectContaining({ tickLower: -480, tickUpper: 480 }),
    );
  });

  it("computes live-ratio mint amounts from balances", async () => {
    mockPoolReads();
    const balance0 = 1_000_000_000n; // 1000 USDC
    const balance1 = 10n ** 18n; // 1 WETH
    const state = await getPoolState({
      ...BASE_PARAMS,
      tickLower: -60,
      tickUpper: 60,
      balance0,
      balance1,
    });

    const expected = computeMintAmounts(Q96, -60, 60, balance0, balance1);
    expect(state.mintAmounts).toEqual({
      amount0Desired: expected.amount0Desired.toString(),
      amount1Desired: expected.amount1Desired.toString(),
      limitingSide: expected.limitingSide,
    });
  });
});
