import { makeConfiguredProvider } from "./lucid.js";

export async function getProtocolParameters(): Promise<unknown> {
  const provider = await makeConfiguredProvider();
  return provider.getProtocolParameters();
}
