import { isAddress } from "viem";
import { describe, expect, it } from "vitest";

import { getChain } from "../src/config.js";

const CANONICAL_NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const CHAIN_IDS = [1, 10, 137, 8453, 42161];
const ADDRESS_FIELDS = ["nfpm", "factory", "universalRouter", "weth9", "quoterV2", "permit2"] as const;

describe("getChain", () => {
  it.each([1, 10, 137, 42161])("returns canonical NFPM for chain %i", (id) => {
    const cfg = getChain(id);
    expect(cfg.nfpm).toBe(CANONICAL_NFPM);
    expect(cfg.rpcUrl).toBeTruthy();
  });

  it("returns Base-specific NFPM for chain 8453", () => {
    const cfg = getChain(8453);
    expect(cfg.nfpm).toBe("0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1");
  });

  it("throws for unsupported chain", () => {
    expect(() => getChain(999)).toThrow("Unsupported chain: 999");
  });

  // A malformed constant (e.g. one hex char short) still type-checks — `Address`
  // is just a `0x${string}` template type with no length/checksum enforcement —
  // so this is the only thing that would actually catch it.
  it.each(CHAIN_IDS)("has a well-formed 20-byte address for every field on chain %i", (id) => {
    const cfg = getChain(id);
    for (const field of ADDRESS_FIELDS) {
      expect(isAddress(cfg[field]), `${field} on chain ${id}: ${cfg[field]}`).toBe(true);
    }
  });
});
