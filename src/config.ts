import type { Address } from "viem";

export interface ChainConfig {
  rpcUrl: string;
  nfpm: Address;
}

/**
 * NonfungiblePositionManager addresses per chain.
 *
 * Most chains use the canonical deployment; Base uses a different address.
 * RPC URLs fall back to public endpoints — override via RPC_<CHAIN> env vars.
 */
const CANONICAL_NFPM: Address =
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

const chains: Record<number, ChainConfig> = {
  1: {
    rpcUrl: process.env.RPC_ETH ?? "https://eth.llamarpc.com",
    nfpm: CANONICAL_NFPM,
  },
  10: {
    rpcUrl: process.env.RPC_OP ?? "https://mainnet.optimism.io",
    nfpm: CANONICAL_NFPM,
  },
  137: {
    rpcUrl: process.env.RPC_POLYGON ?? "https://polygon-rpc.com",
    nfpm: CANONICAL_NFPM,
  },
  8453: {
    rpcUrl: process.env.RPC_BASE ?? "https://mainnet.base.org",
    nfpm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  },
  42161: {
    rpcUrl: process.env.RPC_ARB ?? "https://arb1.arbitrum.io/rpc",
    nfpm: CANONICAL_NFPM,
  },
};

export function getChain(chainId: number): ChainConfig {
  const cfg = chains[chainId];
  if (!cfg) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }
  return cfg;
}
