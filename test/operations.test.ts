import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock the builder layer: operations' own logic is what's under test ──

vi.mock("../src/builder.js", () => ({
  buildCloseTx: vi.fn(),
  buildCollectTx: vi.fn(),
  buildIncreaseLiquidityTx: vi.fn(),
  buildMintTx: vi.fn(),
  buildSwapTx: vi.fn(),
  buildWrapTx: vi.fn(),
  getPoolState: vi.fn(),
  planPosition: vi.fn(),
  simulateTx: vi.fn(),
  toUnsignedRlp: vi.fn(() => "0xr1p"),
}));

import {
  buildCloseTx,
  buildCollectTx,
  buildIncreaseLiquidityTx,
  buildMintTx,
  buildSwapTx,
  buildWrapTx,
  getPoolState,
  planPosition,
  simulateTx,
} from "../src/builder.js";
import {
  SimulationError,
  closeOp,
  collectOp,
  increaseOp,
  mintOp,
  planOp,
  poolStateOp,
  swapOp,
  wrapOp,
} from "../src/operations.js";

const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;
const TOKEN0 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const TOKEN1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const TX = { to: RECIPIENT, data: "0xdeadbeef", value: "0", chainId: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildCollectTx).mockResolvedValue(TX);
  vi.mocked(buildMintTx).mockReturnValue(TX);
  vi.mocked(buildIncreaseLiquidityTx).mockReturnValue(TX);
  vi.mocked(buildWrapTx).mockReturnValue(TX);
  vi.mocked(buildSwapTx).mockReturnValue(TX);
});

// ── collectOp ────────────────────────────────────────────────────────

describe("collectOp", () => {
  const ARGS = { chainId: 1, positionId: 42n, recipient: RECIPIENT };

  it("simulates by default and returns the tx + rlp", async () => {
    const res = await collectOp(ARGS);

    expect(simulateTx).toHaveBeenCalledWith(1, TX, RECIPIENT);
    expect(res).toEqual({
      tx: TX,
      rlp: "0xr1p",
      simulated: true,
      description: "Collect fees from position #42",
    });
  });

  it("skips simulation when simulate=false", async () => {
    const res = await collectOp({ ...ARGS, simulate: false });
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.simulated).toBe(false);
  });

  it("wraps a reverted dry-run in SimulationError", async () => {
    vi.mocked(simulateTx).mockRejectedValueOnce(
      new Error("execution reverted: Not approved"),
    );
    const promise = collectOp(ARGS);
    await expect(promise).rejects.toBeInstanceOf(SimulationError);
    await expect(promise).rejects.toThrow("Not approved");
  });

  it("stringifies non-Error simulation failures", async () => {
    vi.mocked(simulateTx).mockRejectedValueOnce("rpc exploded");
    await expect(collectOp(ARGS)).rejects.toThrow("rpc exploded");
  });
});

// ── closeOp ──────────────────────────────────────────────────────────

describe("closeOp", () => {
  const POSITION = {
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
    tickLower: -60,
    tickUpper: 60,
    liquidity: 1000n,
  };
  const ARGS = { chainId: 1, positionId: 7n, recipient: RECIPIENT };

  beforeEach(() => {
    vi.mocked(buildCloseTx).mockResolvedValue({ tx: TX, position: POSITION });
  });

  it("returns the read position with liquidity as a string", async () => {
    const res = await closeOp(ARGS);

    expect(buildCloseTx).toHaveBeenCalledWith(1, 7n, RECIPIENT, false);
    expect(res.position).toEqual({ ...POSITION, liquidity: "1000" });
    expect(res.simulated).toBe(true);
    expect(res.description).toBe("Close position #7");
  });

  it("describes a liquidity-less close as a collect and appends the burn suffix", async () => {
    vi.mocked(buildCloseTx).mockResolvedValue({
      tx: TX,
      position: { ...POSITION, liquidity: 0n },
    });
    const res = await closeOp({ ...ARGS, burn: true });

    expect(buildCloseTx).toHaveBeenCalledWith(1, 7n, RECIPIENT, true);
    expect(res.description).toBe(
      "Collect remaining tokens from position #7 + burn NFT",
    );
  });
});

// ── mintOp / increaseOp (simulation is opt-in) ───────────────────────

describe("mintOp", () => {
  const ARGS = {
    chainId: 1,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 3000,
    tickLower: -60,
    tickUpper: 60,
    amount0Desired: 1n,
    amount1Desired: 2n,
    recipient: RECIPIENT,
  };

  it("does not simulate by default", async () => {
    const res = await mintOp(ARGS);
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.simulated).toBe(false);
    expect(res.description).toContain(`${TOKEN0}/${TOKEN1} fee=3000`);
    expect(res.description).toContain("[-60, 60]");
  });

  it("simulates when asked", async () => {
    const res = await mintOp({ ...ARGS, simulate: true });
    expect(simulateTx).toHaveBeenCalledWith(1, TX, RECIPIENT);
    expect(res.simulated).toBe(true);
  });
});

describe("increaseOp", () => {
  const ARGS = {
    chainId: 1,
    positionId: 9n,
    amount0Desired: 1n,
    amount1Desired: 2n,
    recipient: RECIPIENT,
  };

  it("does not simulate by default", async () => {
    const res = await increaseOp(ARGS);
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.simulated).toBe(false);
    expect(res.description).toBe("Increase liquidity of position #9");
  });

  it("simulates when asked", async () => {
    const res = await increaseOp({ ...ARGS, simulate: true });
    expect(simulateTx).toHaveBeenCalledWith(1, TX, RECIPIENT);
    expect(res.simulated).toBe(true);
  });
});

// ── read-only passthroughs ───────────────────────────────────────────

describe("planOp / poolStateOp", () => {
  it("delegate to the builder layer untouched", async () => {
    const plan = { tickLower: -60, tickUpper: 60 };
    const state = { pool: RECIPIENT, tick: 0 };
    vi.mocked(planPosition).mockResolvedValue(plan as never);
    vi.mocked(getPoolState).mockResolvedValue(state as never);

    const planArgs = {
      chainId: 1,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 3000,
      priceLower: 1500,
      priceUpper: 2500,
    };
    const stateArgs = { chainId: 1, token0: TOKEN0, token1: TOKEN1, fee: 3000 };

    await expect(planOp(planArgs)).resolves.toBe(plan);
    expect(planPosition).toHaveBeenCalledWith(planArgs);
    await expect(poolStateOp(stateArgs)).resolves.toBe(state);
    expect(getPoolState).toHaveBeenCalledWith(stateArgs);
  });
});

// ── wrapOp / swapOp (simulation needs the actual sender) ─────────────

describe("wrapOp", () => {
  const ARGS = { chainId: 1, amountWei: 10n ** 18n };

  it("skips simulation without a sender", async () => {
    const res = await wrapOp(ARGS);
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.simulated).toBe(false);
    expect(res.description).toBe(
      `Wrap ${10n ** 18n} wei native ETH to WETH via Universal Router`,
    );
  });

  it("rejects simulate=true without a sender", async () => {
    await expect(wrapOp({ ...ARGS, simulate: true })).rejects.toThrow(
      "requires `sender`",
    );
    expect(simulateTx).not.toHaveBeenCalled();
  });

  it("simulates as the sender by default when one is given", async () => {
    const res = await wrapOp({ ...ARGS, sender: RECIPIENT });
    expect(simulateTx).toHaveBeenCalledWith(1, TX, RECIPIENT);
    expect(res.simulated).toBe(true);
  });

  it("honors simulate=false even with a sender", async () => {
    const res = await wrapOp({ ...ARGS, sender: RECIPIENT, simulate: false });
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.simulated).toBe(false);
  });
});

describe("swapOp", () => {
  const ARGS = {
    chainId: 1,
    amountInWei: 5n,
    tokenOut: TOKEN0,
    fee: 3000,
    amountOutMin: 1n,
  };

  it("describes a plain WETH swap", async () => {
    const res = await swapOp(ARGS);
    expect(res.description).toBe(
      `Universal Router: swap 5 wei WETH → ${TOKEN0} (fee 3000)`,
    );
    expect(res.simulated).toBe(false);
  });

  it("describes a wrap-and-swap and simulates as the sender", async () => {
    const res = await swapOp({ ...ARGS, wrapWei: 9n, sender: RECIPIENT });
    expect(simulateTx).toHaveBeenCalledWith(1, TX, RECIPIENT);
    expect(res.description).toBe(
      `Universal Router: wrap 9 wei native ETH, swap 5 wei WETH → ${TOKEN0} (fee 3000), sweep WETH remainder`,
    );
  });
});
