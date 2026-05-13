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
