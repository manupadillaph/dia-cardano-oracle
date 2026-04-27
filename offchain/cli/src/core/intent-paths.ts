import path from "node:path";

export function pairSlugFromSymbol(symbol: string): string {
  const slug = symbol
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "pair";
}

export function unsignedIntentPathForSymbol(symbol: string): string {
  return path.join("./state/preview/intents", `${pairSlugFromSymbol(symbol)}.unsigned.json`);
}

export function signedIntentPathForSymbol(symbol: string): string {
  return path.join("./state/preview/intents", `${pairSlugFromSymbol(symbol)}.signed.json`);
}
