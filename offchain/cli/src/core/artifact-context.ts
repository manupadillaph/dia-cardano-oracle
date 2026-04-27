import path from "node:path";

import {
  readClientState,
  readConfigState,
  readPairState,
  type ClientStateArtifact,
  type ConfigStateArtifact,
  type PairStateArtifact,
} from "./state.js";

export type ClientContext = {
  clientStatePath: string;
  client: ClientStateArtifact;
  protocolStatePath: string;
  protocol: ConfigStateArtifact;
};

export type PairContext = ClientContext & {
  pairStatePath: string;
  pair: PairStateArtifact;
};

export async function readClientContext(args: {
  clientStatePath: string;
  protocolStatePath: string;
}): Promise<ClientContext> {
  const clientStatePath = path.resolve(args.clientStatePath);
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const [client, protocol] = await Promise.all([
    readClientState(clientStatePath),
    readConfigState(protocolStatePath),
  ]);

  return {
    clientStatePath,
    client,
    protocolStatePath,
    protocol,
  };
}

export async function readPairContext(args: {
  pairStatePath: string;
  clientStatePath: string;
  protocolStatePath: string;
}): Promise<PairContext> {
  const pairStatePath = path.resolve(args.pairStatePath);
  const clientStatePath = path.resolve(args.clientStatePath);
  const protocolStatePath = path.resolve(args.protocolStatePath);
  const [pair, client, protocol] = await Promise.all([
    readPairState(pairStatePath),
    readClientState(clientStatePath),
    readConfigState(protocolStatePath),
  ]);

  return {
    pairStatePath,
    pair,
    clientStatePath,
    client,
    protocolStatePath,
    protocol,
  };
}
