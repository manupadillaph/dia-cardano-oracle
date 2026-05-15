# Deep Security And Efficiency Review

## Executive Assessment

The repository implements the full milestone flow across Aiken validators, the TypeScript CLI, local emulator execution, and Preview-oriented evidence. The core safety model remains the coordinator-witness pattern: `update_coordinator` performs cross-UTxO validation, while `pair_state`, `receiver`, and `payment_hook` each enforce their local transition and bind themselves to the exact coordinator redeemer branch in the same transaction.

I do not see an obvious external bypass of the main flows: single update, batch update, settle, receiver withdraw, payment-hook withdraw, or reference-script reclaim. The main trust roots are still the config admin signer set and the authorized DIA signer set. A compromised config signer can rotate protocol-critical fields; a compromised DIA signer can submit arbitrary signed prices for authorized pairs as long as monotonicity and expiry rules are satisfied.

## Current Batch State

The current batch path has two important efficiency changes implemented:

- `update_coordinator.valid_batch_update` no longer performs repeated full input/output scans per witness. It filters pair outputs once, filters pair inputs once, walks witnesses against canonical pair outputs, and accumulates create count inline.
- Existing `pair_state` spends now use `PairSpendAction::ApplyUpdate { witness_index }`. In batch updates, the off-chain builder passes the canonical witness index for each Pair UTxO, and on-chain `pair_intent_satisfied_at` selects that witness directly before checking it names the same Pair NFT and satisfies intent expiry.

Pair mint intentionally still uses identity lookup through `pair_mint_intent_satisfied`, because one `MintPairs` redeemer can cover multiple newly minted Pair NFTs in the same transaction.

Latest local emulator evidence after the indexed pair-spend change and the pair-state duplicate-check cleanup:

| Batch size | Result | CPU | Mem | Note |
|---|---:|---:|---:|---|
| 10 | FAIL | over budget | `Mem -763` | Real Plutus budget failure, not timestamp/preflight |
| 9 | OK | `5183166809` | `13603499` | `fee=2.667151 ADA` |

So the current bytecode supports 9 pairs in the local emulator flow, but 10 pairs still does not fit. The limiting dimension remains memory.

## Findings

The cross-script binding model is coherent after the index change. `pair_state` spends no longer search the whole `ApplyBatch(witnesses)` list; they bind through the redeemer index and then re-check pair identity. That preserves the old safety property while removing the per-pair witness-list scan.

The remaining headroom problem is now in the residual per-pair validation body, not in the previously identified pair-spend witness search. Further optimization should be evidence-driven. Candidate areas include duplicated defence-in-depth checks, datum continuity work, and remaining list work in the coordinator/pair combination. I would not remove signature verification, intent expiry, receiver fee accrual, or Pair NFT continuity.

The emulator `run-all` path now mirrors the CLI batch retry behavior more faithfully: it attempts `10, 9, 8, 7, 6, 5` in descending order and continues after failures until a batch succeeds. The emulator-specific intent generator also pins batch intent timestamp/nonce forward so same-second local execution does not create false stale-intent failures.

## Review Guidance

Present batch capacity as evidence-bound: true for this bytecode, this flow, and the current execution-budget model. Do not describe 10 pairs as solved yet.

Keep the bash CLI flow as the external operator path. The emulator orchestrator can call the same builders directly for speed, but it should not replace the bash run unless that is a separate product decision.

For the next optimization pass, start from the latest emulator evidence and profile the remaining pair/coordinator validators. The index interface change is already done; the next win needs a new bottleneck, not another broad rewrite.
