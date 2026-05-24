// Router — evaluate trigger conditions and dispatch matched intents.
//
// Spectra equivalent:
//   `pkg/router/generic_router.go` (`GenericRouter.processIntentEvent`).
//
// Flow:
//   1. Look up enabled routers that subscribe to the event name.
//   2. For each router evaluate ALL trigger conditions (AND logic).
//      Fail-fast: the first condition that does not pass skips the router.
//   3. For each passing router iterate over its destinations and apply
//      the policy gate (time_threshold, price_deviation).
//   4. Return the set of (router, destinationIndex) pairs that passed,
//      together with their dispatch verdict.
//
// The router does NOT submit anything. It only decides what to submit.
// The caller is responsible for submitting the dispatched intents.
//
// Condition operators match Spectra's Go implementation:
//   in, not_in, eq, neq, gt, lt, gte, lte, contains.
//
// The `field` string follows DIA/Spectra template syntax:
//   "${enrichment.fullIntent.Symbol}" -> enriched.fullIntent.symbol
//   "${enrichment.fullIntent.Price}"  -> enriched.fullIntent.price
//   "${event.signer}"                 -> enriched.event.signer

import type { RouterConfig, RouterDestination, TriggerCondition, TriggerConditionOperator } from "../config/types.js";
import type { PriceCache } from "../processor/price-cache.js";
import type { EnrichedIntent } from "../source/types.js";
import { createPolicyGate, parseDurationMs, parseDeviationPct, type PolicyVerdict } from "./policy.js";
import type { RouterRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DispatchResult = {
  routerId: string;
  destinationIndex: number;
  destination: RouterDestination;
  verdict: PolicyVerdict;
};

export type RouterOutput = {
  /** (router, destination) pairs that passed all conditions AND policy. */
  dispatched: DispatchResult[];
  /** Routers that matched the event but were suppressed by a condition. */
  conditionFiltered: Array<{ routerId: string; reason: string }>;
  /** (router, destination) pairs blocked by policy (time or deviation). */
  policyFiltered: Array<{ routerId: string; destinationIndex: number; verdict: PolicyVerdict }>;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate all routers in the registry against one enriched intent.
 *
 * - `eventName` is the canonical name of the source event, e.g.
 *   `"IntentRegistered"`. Only routers whose `triggers.events` list
 *   contains this name are considered.
 * - `priceCache` is consulted for policy gating per destination.
 * - Returns a `RouterOutput` so the caller can log outcomes at any
 *   verbosity level.
 */
export function routeIntent(
  registry: RouterRegistry,
  priceCache: PriceCache,
  eventName: string,
  enriched: EnrichedIntent,
  clockNow?: () => number,
): RouterOutput {
  const dispatched: DispatchResult[] = [];
  const conditionFiltered: RouterOutput["conditionFiltered"] = [];
  const policyFiltered: RouterOutput["policyFiltered"] = [];

  for (const router of registry.forEvent(eventName)) {
    const conditionResult = evaluateConditions(router, enriched);
    if (!conditionResult.passed) {
      conditionFiltered.push({ routerId: router.id, reason: conditionResult.reason });
      continue;
    }

    for (let i = 0; i < router.destinations.length; i++) {
      const destination = router.destinations[i];
      const symbol = enriched.fullIntent.symbol;
      const cacheKey = { routerId: router.id, destinationIndex: i, symbol };

      const gate = createPolicyGate(priceCache, {
        timeThresholdMs: parseDurationMs(destination.time_threshold),
        priceDeviationPct: parseDeviationPct(destination.price_deviation),
        now: clockNow,
      });
      const verdict = gate(cacheKey, enriched.fullIntent.price);

      if (verdict.allowed) {
        dispatched.push({ routerId: router.id, destinationIndex: i, destination, verdict });
      } else {
        policyFiltered.push({ routerId: router.id, destinationIndex: i, verdict });
      }
    }
  }

  return { dispatched, conditionFiltered, policyFiltered };
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

type ConditionResult = { passed: true } | { passed: false; reason: string };

function evaluateConditions(router: RouterConfig, enriched: EnrichedIntent): ConditionResult {
  const context = buildConditionContext(enriched);
  const conditions = router.triggers.conditions ?? [];
  for (const condition of conditions) {
    const fieldValue = resolveField(context, condition.field);
    if (!evaluateCondition(condition, fieldValue)) {
      return {
        passed: false,
        reason: `condition failed: field="${condition.field}" operator="${condition.operator}" value=${JSON.stringify(condition.value)} actual=${JSON.stringify(serializeFieldValue(fieldValue))}`,
      };
    }
  }
  return { passed: true };
}

/**
 * Resolve a DIA/Spectra template field path against the routing context.
 * Returns `undefined` for absent paths.
 */
function resolveField(context: Record<string, unknown>, fieldPath: string): unknown {
  const parts = normalizeFieldPath(fieldPath).split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeFieldPath(fieldPath: string): string {
  const trimmed = fieldPath.trim();
  return trimmed.startsWith("${") && trimmed.endsWith("}")
    ? trimmed.slice(2, -1).trim()
    : trimmed;
}

function buildConditionContext(enriched: EnrichedIntent): Record<string, unknown> {
  const fullIntent = enriched.fullIntent;
  return {
    enrichment: {
      fullIntent: {
        IntentType: fullIntent.intentType,
        Version: fullIntent.version,
        ChainID: fullIntent.chainId,
        Nonce: fullIntent.nonce,
        Expiry: fullIntent.expiry,
        Symbol: fullIntent.symbol,
        Price: fullIntent.price,
        Timestamp: fullIntent.timestamp,
        Source: fullIntent.source,
        Signature: fullIntent.signature,
        Signer: fullIntent.signer,
      },
    },
    event: enriched.event,
  };
}

/** Coerce a resolved field to a string for comparison. Bigint-safe. */
function serializeFieldValue(value: unknown): string | number | boolean | null {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}

function evaluateCondition(condition: TriggerCondition, fieldValue: unknown): boolean {
  const op = condition.operator;
  const condValue = condition.value;

  // Normalise bigint fields to string for operators that compare strings.
  const normalised = typeof fieldValue === "bigint" ? fieldValue.toString() : fieldValue;

  switch (op) {
    case "eq":
      return normalised == condValue; // intentional loose compare: "10050" == 10050
    case "neq":
      return normalised != condValue;
    case "gt":
      return compareNumeric(normalised, condValue) > 0;
    case "lt":
      return compareNumeric(normalised, condValue) < 0;
    case "gte":
      return compareNumeric(normalised, condValue) >= 0;
    case "lte":
      return compareNumeric(normalised, condValue) <= 0;
    case "in":
      return Array.isArray(condValue) && condValue.some((v) => v == normalised);
    case "not_in":
      return Array.isArray(condValue) && !condValue.some((v) => v == normalised);
    case "contains":
      return typeof normalised === "string" && typeof condValue === "string"
        ? normalised.includes(condValue)
        : false;
    default: {
      // Exhaustiveness: TypeScript will flag this if a new operator is
      // added to `TriggerConditionOperator` without updating this switch.
      const _exhaustive: never = op;
      throw new Error(`Unknown trigger condition operator: "${_exhaustive}".`);
    }
  }
}

function compareNumeric(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    throw new Error(`Cannot compare non-numeric values: "${a}" and "${b}".`);
  }
  return na - nb;
}
