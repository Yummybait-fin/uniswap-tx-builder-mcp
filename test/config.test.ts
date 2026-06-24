import { describe, expect, it } from "vitest";

import { getChain } from "../src/config.js";

const CANONICAL_NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

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
});
