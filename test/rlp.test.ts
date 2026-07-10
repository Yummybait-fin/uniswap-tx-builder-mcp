import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMintTx, toUnsignedRlp } from "../src/builder.js";

// ── golden vector: the first live mint (Base position #5526721) ──────
//
// Broadcast as 0x02f02d93c6f2cb9a480deb9f68338cd88fd84a6aece036330a7b6927fb1d24d9.
// MINT_DATA is that tx's exact on-chain calldata; MINT_RLP is the output of
// the byte-verified reference implementation (onchain-toolkit tx-to-rlp.py)
// for {chainId: 8453, to: NFPM, value: 0, data: MINT_DATA}.

const BASE_NFPM = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as const;
const WETH_BASE = "0x4200000000000000000000000000000000000006" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WALLET = "0x1e6dba05efb3711396db9d0f65406bddf761bbdd" as const;

const MINT_DATA =
  "0x883164560000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffceca8fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcee2e0000000000000000000000000000000000000000000000000001d80c77077add00000000000000000000000000000000000000000000000000000000000f60260000000000000000000000000000000000000000000000000001d5b03e1d33da00000000000000000000000000000000000000000000000000000000000f4c780000000000000000000000001e6dba05efb3711396db9d0f65406bddf761bbdd000000000000000000000000000000000000000000000000000000006a50e8ca" as const;

const MINT_RLP =
  "0x02f90185822105808080809403a520b32c04bf3beef7beb72e919cf822ed34f180b90164883164560000000000000000000000004200000000000000000000000000000000000006000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000000000001f4fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffceca8fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcee2e0000000000000000000000000000000000000000000000000001d80c77077add00000000000000000000000000000000000000000000000000000000000f60260000000000000000000000000000000000000000000000000001d5b03e1d33da00000000000000000000000000000000000000000000000000000000000f4c780000000000000000000000001e6dba05efb3711396db9d0f65406bddf761bbdd000000000000000000000000000000000000000000000000000000006a50e8cac0";

// The broadcast deadline is 0x6a50e8ca; buildMintTx sets now + 1800s.
const MINT_DEADLINE = 0x6a50e8ca;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date((MINT_DEADLINE - 1800) * 1000));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("toUnsignedRlp", () => {
  it("reproduces the live mint tx byte-for-byte (calldata AND rlp)", () => {
    const tx = buildMintTx({
      chainId: 8453,
      token0: WETH_BASE,
      token1: USDC_BASE,
      fee: 500,
      tickLower: -201560,
      tickUpper: -201170,
      amount0Desired: 0x1d80c77077addn,
      amount1Desired: 0xf6026n,
      recipient: WALLET,
    });

    expect(tx.to).toBe(BASE_NFPM);
    expect(tx.value).toBe("0");
    expect(tx.data).toBe(MINT_DATA);
    expect(toUnsignedRlp(tx)).toBe(MINT_RLP);
  });

  it("carries a non-zero value into the serialization", () => {
    const rlp = toUnsignedRlp({
      to: BASE_NFPM,
      data: "0x",
      value: "1120000000000000",
      chainId: 8453,
    });
    // 1120000000000000 wei = 0x03faa252260000 (7 bytes, RLP 0x87-prefixed).
    expect(rlp).toContain("8703faa252260000");
    // type-2 envelope, zeroed nonce/fees/gas, empty access list.
    expect(rlp.startsWith("0x02")).toBe(true);
    expect(rlp.endsWith("c0")).toBe(true);
  });
});
