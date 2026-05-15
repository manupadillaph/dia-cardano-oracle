import { Constr } from "@lucid-evolution/lucid";
import { Data, type Data as PlutusData } from "@lucid-evolution/plutus";

// `PairSpendAction::ApplyUpdate` no longer carries a witness index.
// The Aiken `pair_state.spend` body for updates only checks NFT
// continuity, exact ADA locking, and a fingerprint-based proof that
// the coordinator's redeemer is in update mode. The previous
// `witness_index` field was eliminated because `update_coordinator`
// already enforces one-pair-input-per-witness accounting (and rejects
// extra/duplicate inputs) globally; the per-pair index was redundant.
export function buildPairApplyUpdateRedeemer(): string {
  return Data.to(new Constr<PlutusData>(0, []));
}

// `PairSpendAction::BurnPair` (constructor index 2). Admin-gated path
// used by `pair:burn` to release the locked min-ADA of a Pair UTxO.
// The on-chain validator additionally requires the matching Pair NFT
// to be burned in the same tx under the `PairMintAction::BurnPairs`
// redeemer, so both redeemers MUST be paired for the tx to succeed.
export function buildPairBurnRedeemer(): string {
  return Data.to(new Constr<PlutusData>(2, []));
}

// `PairMintAction::MintPairs` (constructor index 0). Admin-gated. A
// signed DIA intent alone is no longer sufficient: the tx MUST also
// be signed by a `config_admins` payment key. This closes the
// pair-creation replay vector — without the gate, the same DIA intent
// could be reused across two txs to mint two NFTs with the same
// `pair_token_name`.
export function buildPairMintRedeemer(): string {
  return Data.to(new Constr<PlutusData>(0, []));
}

// `PairMintAction::BurnPairs` (constructor index 1). Admin-gated burn
// of one or more Pair NFTs. Every entry in the mint set under this
// redeemer must have quantity `-1`. Used jointly with
// `buildPairBurnRedeemer` to release the locked min-ADA of a Pair
// UTxO.
export function buildPairMintBurnRedeemer(): string {
  return Data.to(new Constr<PlutusData>(1, []));
}
