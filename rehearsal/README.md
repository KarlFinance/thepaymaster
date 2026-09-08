# Rehearsal

Contracts and a harness for practising the crypto-to-crypto distribution before
any of it is real.

## Why a mock USDT rather than a plain ERC-20

Real USDT on Ethereum is not a well-behaved token, and a rehearsal against a
clean one would sail through on Sepolia and revert on mainnet — worse than not
rehearsing, because it produces confidence about the one transaction where
confidence matters. `MockUSDT.sol` reproduces the three things that break naive
code:

- `transfer`, `transferFrom` and `approve` **return nothing**, not a boolean
- `approve` refuses to move a non-zero allowance to another non-zero value
- there is a **blacklist**, and Tether uses it

## The disburser

`Disburser.sol` does one atomic distribution: N transfers out of one call, all
or nothing, funds never resting in the contract. No owner, no pause, no upgrade
path, no withdraw — each of those is a way for somebody to take the money.

**It is not audited and must not touch real funds until it is.** It exists to
prove the shape and to be the thing an auditor is handed.

## Running it

    node compile.js          # solc, optimiser on
    node test-contracts.js   # a real EVM, locally, no chain needed

The local run proves the awkward parts for free: that the disburser copes with
a token returning nothing, that a frozen recipient reverts the *whole*
distribution rather than just their own leg, and that a partial failure moves
nothing at all.

## Getting onto Sepolia

Needs a funded key, which needs a faucet.

1. Make a **brand-new** wallet. Never the real fee wallet — a rehearsal builds
   habits, and pasting the real address into a test is a habit worth not having.
   Testing also needs a private key to hand, and the fee wallet's key should
   never be anywhere near one.
2. Get Sepolia ETH from a faucet — Google's, Alchemy's, or pow.sepolia.dev.
   A fraction of one is plenty.
3. `SEPOLIA_KEY=0x… node deploy.js` deploys the mock and the disburser, mints
   350,000,000 to the sender, and prints the addresses to put on the
   transaction in the platform.

Sepolia's chain id is 11155111, and the platform already knows it.
