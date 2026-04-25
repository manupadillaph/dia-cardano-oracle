import { Constr, type Data as PlutusData } from "@lucid-evolution/lucid";
import { Data } from "@lucid-evolution/plutus";
import { blake2b } from "@noble/hashes/blake2b";
import {
  AbiCoder,
  Signature,
  SigningKey,
  computeAddress,
  keccak256,
  solidityPacked,
  toUtf8Bytes,
} from "ethers";

const abiCoder = AbiCoder.defaultAbiCoder();
const DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)";
const ORACLE_INTENT_TYPE =
  "OracleIntent(string intentType,string version,uint256 chainId,uint256 nonce,uint256 expiry,string symbol,uint256 price,uint256 timestamp,string source)";

export type DiaOracleIntentInput = {
  intentType: string;
  version: string;
  chainId: number | string;
  nonce: number | string;
  expiry: number | string;
  symbol: string;
  price: number | string;
  timestamp: number | string;
  source: string;
  signature: string;
  signer: string;
};

export type UnsignedDiaOracleIntentInput = Omit<
  DiaOracleIntentInput,
  "signature" | "signer"
>;

export type DiaOracleIntentPayload = {
  intentType: string;
  version: string;
  chainId: bigint;
  nonce: bigint;
  expiry: bigint;
  symbol: string;
  price: bigint;
  timestamp: bigint;
  source: string;
};

export type DiaOracleIntent = DiaOracleIntentPayload & {
  signature: string;
  signer: string;
};

export type DiaEip712DomainInput = {
  name: string;
  version: string;
  sourceChainId: number | string;
  verifyingContract: string;
};

export type DiaEip712Domain = {
  name: string;
  version: string;
  sourceChainId: bigint;
  verifyingContract: string;
};

export type DiaOracleIntentWitness = {
  signerPublicKey: string;
  signerAddress: string;
  compactSignature: string;
  intentHash: string;
};

export function normalizeDiaOracleIntent(input: DiaOracleIntentInput): DiaOracleIntent {
  return {
    ...normalizeUnsignedDiaOracleIntent(input),
    signature: normalizeSignatureHex(input.signature, "intent.signature"),
    signer: normalizeEthereumAddressHex(input.signer, "intent.signer"),
  };
}

export function normalizeUnsignedDiaOracleIntent(
  input: UnsignedDiaOracleIntentInput,
): DiaOracleIntentPayload {
  return {
    intentType: input.intentType.trim(),
    version: input.version.trim(),
    chainId: toBigInt(input.chainId, "intent.chainId"),
    nonce: toBigInt(input.nonce, "intent.nonce"),
    expiry: toBigInt(input.expiry, "intent.expiry"),
    symbol: input.symbol.trim(),
    price: toBigInt(input.price, "intent.price"),
    timestamp: toBigInt(input.timestamp, "intent.timestamp"),
    source: input.source.trim(),
  };
}

export function normalizeDiaEip712Domain(
  input: DiaEip712DomainInput,
): DiaEip712Domain {
  return {
    name: input.name.trim(),
    version: input.version.trim(),
    sourceChainId: toBigInt(input.sourceChainId, "domain.sourceChainId"),
    verifyingContract: normalizeEthereumAddressHex(
      input.verifyingContract,
      "domain.verifyingContract",
    ),
  };
}

export function buildDiaDomainSeparator(domain: DiaEip712Domain): string {
  return strip0x(
    keccak256(
      abiCoder.encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address", "bytes32"],
        [
          keccak256(toUtf8Bytes(DOMAIN_TYPE)),
          keccak256(toUtf8Bytes(domain.name)),
          keccak256(toUtf8Bytes(domain.version)),
          domain.sourceChainId,
          with0x(domain.verifyingContract),
          ZERO_32,
        ],
      ),
    ),
  );
}

export function buildDiaOracleIntentStructHash(intent: DiaOracleIntentPayload): string {
  return strip0x(
    keccak256(
      abiCoder.encode(
        [
          "bytes32",
          "bytes32",
          "bytes32",
          "uint256",
          "uint256",
          "uint256",
          "bytes32",
          "uint256",
          "uint256",
          "bytes32",
        ],
        [
          keccak256(toUtf8Bytes(ORACLE_INTENT_TYPE)),
          keccak256(toUtf8Bytes(intent.intentType)),
          keccak256(toUtf8Bytes(intent.version)),
          intent.chainId,
          intent.nonce,
          intent.expiry,
          keccak256(toUtf8Bytes(intent.symbol)),
          intent.price,
          intent.timestamp,
          keccak256(toUtf8Bytes(intent.source)),
        ],
      ),
    ),
  );
}

export function buildDiaOracleIntentHash(
  domain: DiaEip712Domain,
  intent: DiaOracleIntentPayload,
): string {
  return strip0x(
    keccak256(
      solidityPacked(
        ["bytes2", "bytes32", "bytes32"],
        [
          "0x1901",
          with0x(buildDiaDomainSeparator(domain)),
          with0x(buildDiaOracleIntentStructHash(intent)),
        ],
      ),
    ),
  );
}

export function recoverDiaOracleIntentWitness(
  domain: DiaEip712Domain,
  intent: DiaOracleIntent,
): DiaOracleIntentWitness {
  const intentHash = buildDiaOracleIntentHash(domain, intent);
  const signature = Signature.from(with0x(intent.signature));
  const recoveredPublicKey = SigningKey.recoverPublicKey(
    with0x(intentHash),
    signature.serialized,
  );
  const signerPublicKey = strip0x(
    SigningKey.computePublicKey(recoveredPublicKey, true),
  );
  const signerAddress = normalizeEthereumAddressHex(
    computeAddress(recoveredPublicKey),
    "recovered signer address",
  );

  if (signerAddress !== intent.signer) {
    throw new Error(
      `Recovered signer ${with0x(signerAddress)} does not match intent.signer ${with0x(intent.signer)}.`,
    );
  }

  return {
    signerPublicKey,
    signerAddress,
    compactSignature: `${strip0x(signature.r)}${strip0x(signature.s)}`,
    intentHash,
  };
}

export function signDiaOracleIntentInput(args: {
  domain: DiaEip712DomainInput;
  intent: UnsignedDiaOracleIntentInput;
  privateKey: string;
}): {
  intent: DiaOracleIntentInput;
  signerPublicKey: string;
  signerAddress: string;
  compactSignature: string;
  intentHash: string;
} {
  const domain = normalizeDiaEip712Domain(args.domain);
  const intentPayload = normalizeUnsignedDiaOracleIntent(args.intent);
  const intentHash = buildDiaOracleIntentHash(domain, intentPayload);
  const signingKey = new SigningKey(with0x(normalizePrivateKey(args.privateKey)));
  const signature = signingKey.sign(with0x(intentHash));
  const publicKey = signingKey.publicKey;
  const signerPublicKey = strip0x(SigningKey.computePublicKey(publicKey, true));
  const signerAddress = normalizeEthereumAddressHex(
    computeAddress(publicKey),
    "intent.signer",
  );
  const signedIntent = {
    intentType: args.intent.intentType,
    version: args.intent.version,
    chainId: args.intent.chainId,
    nonce: args.intent.nonce,
    expiry: args.intent.expiry,
    symbol: args.intent.symbol,
    price: args.intent.price,
    timestamp: args.intent.timestamp,
    source: args.intent.source,
    signature: signature.serialized,
    signer: with0x(signerAddress),
  };
  const witness = recoverDiaOracleIntentWitness(
    domain,
    normalizeDiaOracleIntent(signedIntent),
  );

  return {
    intent: signedIntent,
    signerPublicKey,
    signerAddress: with0x(signerAddress),
    compactSignature: witness.compactSignature,
    intentHash,
  };
}

export function diaOracleIntentToData(intent: DiaOracleIntent): Constr<PlutusData> {
  return new Constr<PlutusData>(0, [
    utf8ToHex(intent.intentType),
    utf8ToHex(intent.version),
    intent.chainId,
    intent.nonce,
    intent.expiry,
    utf8ToHex(intent.symbol),
    intent.price,
    intent.timestamp,
    utf8ToHex(intent.source),
    intent.signature,
    intent.signer,
  ]);
}

export function diaOracleIntentToCbor(intent: DiaOracleIntent): string {
  return Data.to(diaOracleIntentToData(intent));
}

export function diaOracleRedeemerToCbor(args: {
  intent: DiaOracleIntent;
  signerPublicKey: string;
}): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      diaOracleIntentToData(args.intent),
      normalizeHex(args.signerPublicKey, "signerPublicKey"),
    ]),
  );
}

export function diaOracleDatumToCbor(args: {
  intent: DiaOracleIntent;
  signerPublicKey: string;
  intentHash: string;
}): string {
  return Data.to(
    new Constr<PlutusData>(0, [
      utf8ToHex(args.intent.symbol),
      args.intent.price,
      args.intent.timestamp,
      args.intent.nonce,
      normalizeHex(args.intentHash, "intentHash"),
      args.intent.signer,
      normalizeHex(args.signerPublicKey, "signerPublicKey"),
      args.intent.signature,
      diaOracleIntentToCbor(args.intent),
    ]),
  );
}

export function diaPairIdHex(intent: DiaOracleIntent): string {
  return utf8ToHex(intent.symbol);
}

export function diaIntentTokenNameFromSymbol(intent: DiaOracleIntent): string {
  return blake2bHex(utf8ToHex(intent.symbol));
}

export function pairAssetNameFromPairIdHex(pairId: string): string {
  return blake2bHex(normalizeHex(pairId, "pairId"));
}

export function diaIntentToState(intent: DiaOracleIntent): DiaOracleIntentInput {
  return {
    intentType: intent.intentType,
    version: intent.version,
    chainId: intent.chainId.toString(),
    nonce: intent.nonce.toString(),
    expiry: intent.expiry.toString(),
    symbol: intent.symbol,
    price: intent.price.toString(),
    timestamp: intent.timestamp.toString(),
    source: intent.source,
    signature: intent.signature,
    signer: with0x(intent.signer),
  };
}

export function normalizeHex(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;

  if (!/^[0-9a-f]*$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Expected ${label} to be an even-length hex string.`);
  }

  return normalized;
}

export function normalizeEthereumAddressHex(value: string, label: string): string {
  const normalized = normalizeHex(value, label);

  if (normalized.length !== 40) {
    throw new Error(`Expected ${label} to be a 20-byte Ethereum address.`);
  }

  return normalized;
}

export function utf8ToHex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

function normalizeSignatureHex(value: string, label: string): string {
  const normalized = normalizeHex(value, label);

  if (normalized.length !== 128 && normalized.length !== 130) {
    throw new Error(`Expected ${label} to be a 64-byte or 65-byte secp256k1 signature.`);
  }

  return normalized;
}

function normalizePrivateKey(value: string): string {
  const normalized = normalizeHex(value, "DIA_EVM_PRIVATE_KEY");

  if (normalized.length !== 64) {
    throw new Error("Expected DIA_EVM_PRIVATE_KEY to be a 32-byte Ethereum private key.");
  }

  return normalized;
}

function toBigInt(value: string | number, label: string): bigint {
  const normalized = typeof value === "number" ? value.toString() : value.trim();

  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Expected ${label} to be an integer.`);
  }

  return BigInt(normalized);
}

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2).toLowerCase() : value.toLowerCase();
}

function blake2bHex(hexValue: string): string {
  return Buffer.from(blake2b(Buffer.from(hexValue, "hex"), { dkLen: 32 })).toString("hex");
}

function with0x(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

const ZERO_32 = `0x${"00".repeat(32)}`;
