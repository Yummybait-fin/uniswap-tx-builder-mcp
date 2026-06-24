---
name: uniswap-tx-builder
description: Build unsigned Uniswap v3 liquidity-position transactions with the uniswap-tx-builder MCP — collect fees, close (remove liquidity + collect, optionally burn), mint a new position, increase liquidity, and plan a position from a human price range — simulate them, then hand the calldata to your own wallet to sign. Use whenever you need to manage, rebalance, open, or close a Uniswap v3 LP position through this MCP. Generic: no app- or wallet-specific knowledge.
---

# uniswap-tx-builder

This skill ships with the **uniswap-tx-builder MCP** — a public, **keyless** server that builds
*unsigned* Uniswap v3 position transactions and (optionally) simulates them. **It never holds
keys and never signs.** You build calldata here, then sign + broadcast with *your own* wallet
(any signer — a CDP wallet MCP, viem, etc.).

## Tools

All return `tx = { to, data, value, chainId }` (value is `"0"` — these calls are non-payable),
plus a `description`. Addresses are `0x…40`; `positionId`/amounts are decimal **strings** (they
exceed JS safe integers).

| Tool | Args | Notes |
|------|------|-------|
| `build_collect` | `chainId, positionId, recipient, simulate?` | Collect all uncollected fees to `recipient`. |
| `build_close` | `chainId, positionId, recipient, burn?, simulate?` | Remove all liquidity **+** collect. `burn: true` also burns the now-empty NFT in the same multicall. Returns the read `position` (token0/1, fee, tickLower/Upper, liquidity). |
| `build_mint` | `chainId, token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, recipient, slippageBps?, simulate?` | Mint a new position. |
| `build_increase` | `chainId, positionId, amount0Desired, amount1Desired, recipient, slippageBps?, simulate?` | Add liquidity to an **existing** position. |
| `plan_position` | `chainId, token0, token1, fee, priceLower, priceUpper, amount0?, amount1?` | **Read-only** helper, builds no tx. Turns a human price range + human amounts into aligned `tickLower/tickUpper` + wei `amount0Desired/amount1Desired` ready for `build_mint`. |

- **`simulate`** runs an `eth_call` dry-run. **On by default for collect/close** — keep it on so
  you only ever sign txs that would succeed. **Off by default for mint/increase** (they need token
  approvals + balances, so the dry-run usually reverts); pass `simulate: true` only if those are
  already in place.
- A simulation failure comes back as an error — **do not sign** a tx that failed to simulate.

### `plan_position` (the math helper)

`build_mint`/`build_increase` take **raw** ticks and **wei** amounts. When you only have a human
price range and token amounts, call `plan_position` first:

- `priceLower`/`priceUpper` are **token1 per token0** in whole-token units; they're reordered if
  given high→low, and snapped to the fee tier's tick spacing.
- `token0` **must be `<` `token1`** by address (Uniswap's ordering). If they aren't, swap the pair
  and invert the prices — the tool errors otherwise.
- It reads each token's `decimals` over RPC to convert `amount0`/`amount1` to wei.
- It does **not** compute the optimal amount ratio for the range — pass the amounts you intend to
  deposit. Then splat the result into `build_mint`.

## Signing (your wallet, not this MCP)

Take the returned `tx` and sign + broadcast it with your own signer. This MCP is keyless, so the
only limits that apply are **your wallet's** (e.g. a CDP Wallet Policy). If your wallet rejects
the tx, report it — never try to route around the wallet's policy.

For `build_mint` and `build_increase`, your wallet must hold the input tokens **and have an ERC-20
approval to the NonfungiblePositionManager** beforehand — that's the signer's responsibility, not
this MCP's. (This is also why their `simulate` is off by default.)

## Position lifecycle

- **Collect fees:** `build_collect` → sign.
- **Add liquidity:** `build_increase` → sign (after approvals).
- **Close:** `build_close` → sign. Use the returned `position` (pair, range, liquidity) to inform
  the decision. Pass `burn: true` if you want the empty NFT gone too.
- **Open with a price range:** `plan_position` → `build_mint` → sign.
- **Rebalance** = **close → mint a recentered range.** The mint amounts depend on the tokens freed
  by the close, so **do the close first**, then `plan_position` + `build_mint` the new range once
  those balances are realized (typically a later step/cycle). Center the new range on the current
  price; widen it for volatile pairs, tighten it for stable pairs.

## Chains

Supports the chains configured in the MCP (NFPM address per chain): Ethereum (1), Optimism (10),
Polygon (137), Base (8453), Arbitrum (42161). Calling an unconfigured chain returns an "Unsupported
chain" error.
