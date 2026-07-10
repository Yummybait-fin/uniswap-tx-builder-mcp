import type { Address } from "viem";

export interface ChainConfig {
  rpcUrl: string;
  nfpm: Address;
  factory: Address;
  /** Universal Router v1.2 — the deployment wallet policies allowlist. */
  universalRouter: Address;
  /** Canonical wrapped-native token (WETH9; WMATIC on Polygon). */
  weth9: Address;
}

/**
 * Uniswap v3 core + periphery addresses per chain.
 *
 * Most chains use the canonical deployments; Base differs for NFPM/factory.
 * The Universal Router v1.2 lives at the same CREATE2 address on every chain
 * here (verified via eth_getCode). RPC URLs fall back to public endpoints —
 * override via RPC_<CHAIN> env vars.
 */
const CANONICAL_NFPM: Address =
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const CANONICAL_FACTORY: Address =
  "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNIVERSAL_ROUTER_V1_2: Address =
  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD";

const chains: Record<number, ChainConfig> = {
  1: {
    rpcUrl: process.env.RPC_ETH ?? "https://eth.llamarpc.com",
    nfpm: CANONICAL_NFPM,
    factory: CANONICAL_FACTORY,
    universalRouter: UNIVERSAL_ROUTER_V1_2,
    weth9: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  10: {
    rpcUrl: process.env.RPC_OP ?? "https://mainnet.optimism.io",
    nfpm: CANONICAL_NFPM,
    factory: CANONICAL_FACTORY,
    universalRouter: UNIVERSAL_ROUTER_V1_2,
    weth9: "0x4200000000000000000000000000000000000006",
  },
  137: {
    rpcUrl: process.env.RPC_POLYGON ?? "https://polygon-rpc.com",
    nfpm: CANONICAL_NFPM,
    factory: CANONICAL_FACTORY,
    universalRouter: UNIVERSAL_ROUTER_V1_2,
    weth9: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
  },
  8453: {
    rpcUrl: process.env.RPC_BASE ?? "https://mainnet.base.org",
    nfpm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    universalRouter: UNIVERSAL_ROUTER_V1_2,
    weth9: "0x4200000000000000000000000000000000000006",
  },
  42161: {
    rpcUrl: process.env.RPC_ARB ?? "https://arb1.arbitrum.io/rpc",
    nfpm: CANONICAL_NFPM,
    factory: CANONICAL_FACTORY,
    universalRouter: UNIVERSAL_ROUTER_V1_2,
    weth9: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
};

export function getChain(chainId: number): ChainConfig {
  const cfg = chains[chainId];
  if (!cfg) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }
  return cfg;
}
