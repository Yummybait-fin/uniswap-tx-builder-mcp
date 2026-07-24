---
name: uniswap-tx-builder
description: Build unsigned Uniswap v3 liquidity-position transactions with the uniswap-tx-builder MCP — list a wallet's positions, collect fees, close (remove liquidity + collect, optionally burn), mint a new position, increase liquidity, approve ERC-20 spending limits, wrap native ETH / swap WETH via the Universal Router, read live pool state, and plan a position from a human price range — simulate them, then hand the calldata (or the ready-made unsigned RLP) to your own wallet to sign. Use whenever you need to manage, rebalance, open, or close a Uniswap v3 LP position through this MCP. Generic: no app- or wallet-specific knowledge.
---

# uniswap-tx-builder

This skill ships with the **uniswap-tx-builder MCP** — a public, **keyless** server that builds
*unsigned* Uniswap v3 position transactions and (optionally) simulates them. **It never holds
keys and never signs.** You build calldata here, then sign + broadcast with *your own* wallet
(any signer — a CDP wallet MCP, viem, etc.).

## Tools

All build tools return `tx = { to, data, value, chainId }`, `rlp`, and a `description`.
`value` is `"0"` except `build_wrap`/`build_swap` with native ETH (payable). Addresses are
`0x…40`; `positionId`/amounts are decimal **strings** (they exceed JS safe integers).

`rlp` is the **unsigned EIP-1559 (type-2)** serialization of `tx` with nonce, fees and gas
zeroed — pass it directly to signing services that populate those at signing time (e.g. a CDP
wallet MCP `send_transaction`). If your signer manages nonces itself, serialize `tx` instead.

| Tool | Args | Notes |
|------|------|-------|
| `build_collect` | `chainId, positionId, recipient, simulate?` | Collect all uncollected fees to `recipient`. |
| `build_close` | `chainId, positionId, recipient, burn?, simulate?` | Remove all liquidity **+** collect. `burn: true` also burns the now-empty NFT in the same multicall. Returns the read `position` (token0/1, fee, tickLower/Upper, liquidity). |
| `build_mint` | `chainId, token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, recipient, slippageBps?, simulate?` | Mint a new position. Get the amounts from `get_pool_state` **immediately before** this call. |
| `build_increase` | `chainId, positionId, amount0Desired, amount1Desired, recipient, slippageBps?, simulate?` | Add liquidity to an **existing** position. |
| `build_approve` | `chainId, token, spender, amount, sender?, simulate?` | Approve `spender` (e.g. the NFPM, or Permit2) to move up to `amount` of `token`. `amount: "max"` for an unlimited (uint256 max) allowance. |
| `build_wrap` | `chainId, amountWei, recipient?, sender?, deadline?, simulate?` | Native ETH → WETH via Universal Router `WRAP_ETH` (payable; works under UR-allowlisting wallet policies where `WETH.deposit()` doesn't). |
| `build_swap` | `chainId, amountInWei, tokenOut, fee, amountOutMin, recipient?, wrapWei?, sender?, deadline?, simulate?` | Exact-in single-hop WETH → `tokenOut`. With `wrapWei` (≥ `amountInWei`): wraps that much native ETH, swaps `amountInWei`, sweeps the WETH remainder — one payable tx. Without it: pays WETH via **Permit2** (needs a Permit2 approval). |
| `plan_position` | `chainId, token0, token1, fee, priceLower, priceUpper, amount0?, amount1?` | **Read-only.** Human price range + human amounts → aligned ticks + wei amounts. |
| `get_pool_state` | `chainId, token0, token1, fee, rangePct?, tickLower?, tickUpper?, balance0?, balance1?` | **Read-only.** Live `pool`, `tick`, `sqrtPriceX96`, `price` (token1 per token0, human), `tickSpacing`. See below. |
| `get_positions` | `chainId, owner` | **Read-only.** Every position NFT `owner` holds (token0/1, fee, tickLower/Upper, liquidity, tokensOwed0/1). Feed a `positionId` into `build_collect`/`build_close`/`build_increase`. |

- **`simulate`** runs an `eth_call` dry-run. **On by default for collect/close** — keep it on so
  you only ever sign txs that would succeed. **Off by default for mint/increase** (they need token
  approvals + balances); pass `simulate: true` only if those are already in place. For
  **wrap/swap/approve**, pass `sender` (the wallet that will sign) — simulation then runs by
  default with the correct `from` and `value`.
- A simulation failure comes back as an error — **do not sign** a tx that failed to simulate.
- `recipient` on wrap/swap **defaults to the tx sender** (the router's `MSG_SENDER` placeholder).
  Omit it unless the output must go to a different address.

### `get_pool_state` (live spot → range → mint amounts)

The one tool to call **right before every mint**:

1. `rangePct: 2` → `suggested.tickLower/tickUpper` within ±2% of spot, **rounded inward** to the
   tick spacing (the range never exceeds your stated width).
2. `tickLower + tickUpper + balance0 + balance1` (raw wei balances) → `mintAmounts.
   amount0Desired/amount1Desired` computed from the **live** sqrtPrice ratio, plus
   `limitingSide` (which balance caps the position). Feed these straight into `build_mint`.
   It errors if spot has moved outside the range — recompute the range, don't force the mint.

Amounts computed from a stale price revert the mint with **"Price slippage check"** — always
recompute in the same breath as `build_mint`.

### `plan_position` (human price range → ticks)

When you start from a human price range instead of a ±pct width: `priceLower`/`priceUpper` are
**token1 per token0** in whole-token units, reordered if given high→low, snapped to the fee
tier's tick spacing. It reads `decimals` over RPC to convert `amount0`/`amount1` to wei, but does
**not** compute the range-optimal ratio — use `get_pool_state` with balances for that.

`token0` **must be `<` `token1`** by address (Uniswap's ordering) for both planning tools. If
they aren't, swap the pair and invert the prices — the tools error otherwise.

## Signing (your wallet, not this MCP)

Take the returned `rlp` (for signing services that fill nonce/fees) or `tx` (for signers that
serialize themselves) and sign + broadcast with your own signer. This MCP is keyless, so the only
limits that apply are **your wallet's** (e.g. a CDP Wallet Policy). If your wallet rejects the
tx, report it — never try to route around the wallet's policy.

For `build_mint` and `build_increase`, your wallet must hold the input tokens **and have an
ERC-20 approval to the NonfungiblePositionManager** beforehand — build that approval with
`build_approve` (`spender` = the chain's NFPM address) and sign it first. (This is also why
`build_mint`/`build_increase`'s `simulate` is off by default — the dry-run reverts without an
approval in place already.) A Permit2-paid `build_swap` (no `wrapWei`) similarly needs a
`build_approve` for Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA` on every EVM chain) as
`spender` beforehand. `build_wrap`/`build_swap` use the Universal Router v1.2
(`0x3fC91A3a…B2b7FAD`) — the address wallet policies typically allowlist.

## Position lifecycle

- **Find positions:** `get_positions` (by owner) → pick a `positionId` for collect/close/increase.
- **Collect fees:** `build_collect` → sign.
- **Add liquidity:** `build_increase` → sign (after `build_approve`-ing the NFPM, if not already).
- **Close:** `build_close` → sign. Use the returned `position` (pair, range, liquidity) to inform
  the decision. Pass `burn: true` if you want the empty NFT gone too.
- **Open around spot:** `get_pool_state` (rangePct → ticks, balances → amounts) → `build_approve`
  (NFPM, if not already) → `build_mint` → sign. If the wallet holds native ETH instead of WETH:
  `build_swap` with `wrapWei` (or `build_wrap`) first, confirm, then recompute amounts and mint.
- **Open with a price range:** `plan_position` → `get_pool_state` (balances → amounts) →
  `build_approve` (NFPM) → `build_mint` → sign.
- **Rebalance** = **close → mint a recentered range.** The mint amounts depend on the tokens
  freed by the close, so **do the close first**, then `get_pool_state` + `build_mint` the new
  range once those balances are realized (typically a later step/cycle). Center the new range on
  the current price; widen it for volatile pairs, tighten it for stable pairs.

## Chains

Supports the chains configured in the MCP (NFPM/factory/Universal Router/WETH9 per chain):
Ethereum (1), Optimism (10), Polygon (137), Base (8453), Arbitrum (42161). On Polygon the
"wrapped native" is WMATIC. Calling an unconfigured chain returns an "Unsupported chain" error.
