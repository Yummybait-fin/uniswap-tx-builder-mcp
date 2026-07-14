import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock the op layer: the tool surface (schemas + run wrapper) is under test ──

vi.mock("../src/operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations.js")>();
  return {
    ...actual,
    collectOp: vi.fn(),
    closeOp: vi.fn(),
    mintOp: vi.fn(),
    increaseOp: vi.fn(),
    planOp: vi.fn(),
    poolStateOp: vi.fn(),
    wrapOp: vi.fn(),
    swapOp: vi.fn(),
  };
});

import {
  closeOp,
  collectOp,
  increaseOp,
  mintOp,
  planOp,
  poolStateOp,
  swapOp,
  wrapOp,
} from "../src/operations.js";
import { buildServer } from "../src/server.js";

const RECIPIENT = "0x1234567890AbcdEF1234567890aBcdef12345678";
const TOKEN0 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TOKEN1 = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const TOOL_NAMES = [
  "build_collect",
  "build_close",
  "build_mint",
  "build_increase",
  "plan_position",
  "get_pool_state",
  "build_wrap",
  "build_swap",
];

/** A connected client/server pair over an in-memory transport. */
async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    buildServer().connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildServer", () => {
  it("exposes all eight tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("coerces string args and returns the op payload as JSON text", async () => {
    const payload = {
      tx: { to: RECIPIENT, data: "0xdeadbeef", value: "0", chainId: 1 },
      rlp: "0xr1p",
      simulated: true,
      description: "Collect fees from position #42",
    };
    vi.mocked(collectOp).mockResolvedValueOnce(payload);

    const client = await connect();
    const res = await client.callTool({
      name: "build_collect",
      arguments: { chainId: 1, positionId: "42", recipient: RECIPIENT },
    });

    expect(collectOp).toHaveBeenCalledWith({
      chainId: 1,
      positionId: 42n, // decimal string → bigint at the tool boundary
      recipient: RECIPIENT,
      simulate: undefined,
    });
    expect(res.isError).toBeFalsy();
    const [content] = res.content as Array<{ type: string; text: string }>;
    expect(content.type).toBe("text");
    expect(JSON.parse(content.text)).toEqual(payload);
  });

  it("rejects args that fail the schema before reaching the op", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "build_collect",
      arguments: { chainId: 1, positionId: "42", recipient: "not-an-address" },
    });
    expect(res.isError).toBe(true);
    const [content] = res.content as Array<{ type: string; text: string }>;
    expect(content.text).toContain("must be a 0x EVM address");
    expect(collectOp).not.toHaveBeenCalled();
  });

  it("returns a thrown op error as an MCP tool error", async () => {
    vi.mocked(mintOp).mockRejectedValueOnce(
      new Error("Spot price is outside [-60, 60]"),
    );

    const client = await connect();
    const res = await client.callTool({
      name: "build_mint",
      arguments: {
        chainId: 1,
        token0: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        token1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        fee: 3000,
        tickLower: -60,
        tickUpper: 60,
        amount0Desired: "1",
        amount1Desired: "2",
        recipient: RECIPIENT,
      },
    });

    expect(res.isError).toBe(true);
    const [content] = res.content as Array<{ type: string; text: string }>;
    expect(content.text).toBe(
      "build_mint failed: Spot price is outside [-60, 60]",
    );
  });

  // Every remaining tool: wire args through and check the uint-string → bigint
  // coercions land on the op boundary.
  it.each([
    {
      tool: "build_close",
      op: closeOp,
      args: { chainId: 1, positionId: "7", recipient: RECIPIENT, burn: true },
      expected: {
        chainId: 1,
        positionId: 7n,
        recipient: RECIPIENT,
        burn: true,
        simulate: undefined,
      },
    },
    {
      tool: "build_increase",
      op: increaseOp,
      args: {
        chainId: 1,
        positionId: "9",
        amount0Desired: "1",
        amount1Desired: "2",
        recipient: RECIPIENT,
      },
      expected: {
        chainId: 1,
        positionId: 9n,
        amount0Desired: 1n,
        amount1Desired: 2n,
        recipient: RECIPIENT,
        slippageBps: undefined,
        simulate: undefined,
      },
    },
    {
      tool: "plan_position",
      op: planOp,
      args: {
        chainId: 1,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 3000,
        priceLower: 1500,
        priceUpper: 2500,
      },
      expected: {
        chainId: 1,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 3000,
        priceLower: 1500,
        priceUpper: 2500,
        amount0: undefined,
        amount1: undefined,
      },
    },
    {
      tool: "get_pool_state",
      op: poolStateOp,
      args: {
        chainId: 1,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 3000,
        rangePct: 5,
        balance0: "5",
      },
      expected: {
        chainId: 1,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 3000,
        rangePct: 5,
        tickLower: undefined,
        tickUpper: undefined,
        balance0: 5n,
        balance1: undefined,
      },
    },
    {
      tool: "build_wrap",
      op: wrapOp,
      args: { chainId: 1, amountWei: "1000" },
      expected: {
        chainId: 1,
        amountWei: 1000n,
        recipient: undefined,
        sender: undefined,
        deadline: undefined,
        simulate: undefined,
      },
    },
    {
      tool: "build_swap",
      op: swapOp,
      args: {
        chainId: 1,
        amountInWei: "5",
        tokenOut: TOKEN0,
        fee: 3000,
        amountOutMin: "1",
        wrapWei: "9",
        sender: RECIPIENT,
      },
      expected: {
        chainId: 1,
        amountInWei: 5n,
        tokenOut: TOKEN0,
        fee: 3000,
        amountOutMin: 1n,
        recipient: undefined,
        wrapWei: 9n,
        sender: RECIPIENT,
        deadline: undefined,
        simulate: undefined,
      },
    },
  ])("routes $tool to its op with coerced args", async ({ tool, op, args, expected }) => {
    const payload = { description: `${tool} result` };
    vi.mocked(op).mockResolvedValueOnce(payload as never);

    const client = await connect();
    const res = await client.callTool({ name: tool, arguments: args });

    expect(op).toHaveBeenCalledWith(expected);
    expect(res.isError).toBeFalsy();
    const [content] = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content.text)).toEqual(payload);
  });

  it("collapses long calldata in logs but not in the returned payload", async () => {
    const longData = `0x${"ab".repeat(500)}`;
    const payload = {
      tx: { to: RECIPIENT, data: longData, value: "0", chainId: 1 },
      rlp: "0xr1p",
      simulated: false,
      description: "big tx",
    };
    vi.mocked(collectOp).mockResolvedValueOnce(payload);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const client = await connect();
    const res = await client.callTool({
      name: "build_collect",
      arguments: { chainId: 1, positionId: "1", recipient: RECIPIENT, simulate: false },
    });

    const [content] = res.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content.text).tx.data).toBe(longData); // full fidelity out
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("…(500 bytes)"); // collapsed in the log line
    expect(logged).not.toContain(longData);
  });
});
