import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";

import { universalRouterAbi } from "../src/abi.js";
import { buildSwapTx, buildWrapTx } from "../src/builder.js";

const UR = "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";

// ── golden vector: the first live wrap+swap (Base) ───────────────────
//
// Broadcast as 0xe4390e84be7698abfe3dacd799a877d1667e9f6fad70f0a7cd3cafd6af202d15:
// wrap 0.00112 ETH, swap 0.00056 WETH → USDC (fee 500, min 1002500), sweep the
// WETH remainder back to the sender. SWAP_DATA is that tx's exact calldata.

const SWAP_DEADLINE = 0x6a50e282; // 1783161474

const SWAP_DATA =
  "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006a50e28200000000000000000000000000000000000000000000000000000000000000030b000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001e0000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000003faa252260000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000001fd512913000000000000000000000000000000000000000000000000000000000000000f4c0400000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002b42000000000000000000000000000000000000060001f4833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000001fd5129130000" as const;

describe("buildSwapTx", () => {
  it("reproduces the live wrap+swap tx byte-for-byte", () => {
    const tx = buildSwapTx({
      chainId: 8453,
      amountInWei: 560000000000000n,
      tokenOut: USDC_BASE,
      fee: 500,
      amountOutMin: 1002500n,
      wrapWei: 1120000000000000n,
      deadline: SWAP_DEADLINE,
    });

    expect(tx.to).toBe(UR);
    expect(tx.chainId).toBe(8453);
    expect(tx.value).toBe("1120000000000000");
    expect(tx.data).toBe(SWAP_DATA);
  });

  it("builds a plain Permit2-paid swap when wrapWei is omitted", () => {
    const tx = buildSwapTx({
      chainId: 8453,
      amountInWei: 1000n,
      tokenOut: USDC_BASE,
      fee: 500,
      amountOutMin: 1n,
      deadline: SWAP_DEADLINE,
    });

    expect(tx.value).toBe("0");
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
    const [commands, inputs, deadline] = decoded.args;
    expect(commands).toBe("0x00"); // V3_SWAP_EXACT_IN only
    expect(inputs).toHaveLength(1);
    expect(deadline).toBe(BigInt(SWAP_DEADLINE));
    // payerIsUser=true → last word of the head is 1.
    expect(inputs[0]).toContain(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("encodes a literal recipient when one is provided", () => {
    const recipient = "0x1234567890AbcdEF1234567890aBcdef12345678" as const;
    const tx = buildSwapTx({
      chainId: 8453,
      amountInWei: 1000n,
      tokenOut: USDC_BASE,
      fee: 500,
      amountOutMin: 1n,
      recipient,
      deadline: SWAP_DEADLINE,
    });
    expect(tx.data.toLowerCase()).toContain(recipient.slice(2).toLowerCase());
  });

  it("rejects wrapWei below amountInWei", () => {
    expect(() =>
      buildSwapTx({
        chainId: 8453,
        amountInWei: 1000n,
        tokenOut: USDC_BASE,
        fee: 500,
        amountOutMin: 1n,
        wrapWei: 999n,
      }),
    ).toThrow("wrapWei");
  });
});

describe("buildWrapTx", () => {
  it("encodes WRAP_ETH to the sender placeholder by default", () => {
    const tx = buildWrapTx({
      chainId: 8453,
      amountWei: 1000000000000000n,
      deadline: SWAP_DEADLINE,
    });

    expect(tx.to).toBe(UR);
    expect(tx.value).toBe("1000000000000000");
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
    const [commands, inputs] = decoded.args;
    expect(commands).toBe("0x0b"); // WRAP_ETH only
    expect(inputs).toHaveLength(1);
    // (address recipient, uint256 amount) — MSG_SENDER placeholder + amount.
    expect(inputs[0]).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001" +
        "00000000000000000000000000000000000000000000000000038d7ea4c68000",
    );
  });

  it("routes wrap custody correctly: sender for wrap-only, router for wrap+swap", () => {
    const firstWord = (input: string) => input.slice(2, 66);

    const wrapOnly = buildWrapTx({ chainId: 8453, amountWei: 1n, deadline: 1 });
    const [, wrapInputs] = decodeFunctionData({
      abi: universalRouterAbi,
      data: wrapOnly.data,
    }).args;
    expect(firstWord(wrapInputs[0])).toBe(MSG_SENDER.slice(2).padStart(64, "0"));

    const wrapSwap = buildSwapTx({
      chainId: 8453,
      amountInWei: 1n,
      tokenOut: USDC_BASE,
      fee: 500,
      amountOutMin: 1n,
      wrapWei: 2n,
      deadline: 1,
    });
    const [, swapInputs] = decodeFunctionData({
      abi: universalRouterAbi,
      data: wrapSwap.data,
    }).args;
    // WRAP_ETH custody goes to the router; swap output + sweep to the sender.
    expect(firstWord(swapInputs[0])).toBe(ADDRESS_THIS.slice(2).padStart(64, "0"));
    expect(firstWord(swapInputs[1])).toBe(MSG_SENDER.slice(2).padStart(64, "0"));
  });
});
