// Force CARDANO_NETWORK=Preview for the entire test suite, regardless of the
// developer's .env. Test fixtures (state artifacts, step IDs, wallet addresses)
// are synthetic and assume Preview semantics. Tests that need to validate
// Mainnet behavior must explicitly override process.env.CARDANO_NETWORK in a
// try/finally block (see testCardanoWalletCreate).
//
// This file MUST be imported before any module that reads CARDANO_NETWORK at
// load time (core/config.ts calls loadDotenv at module init). Setting the env
// var here, before `dotenv` runs, prevents `.env` from overwriting it because
// `dotenv.config()` does not overwrite existing process.env values.
process.env.CARDANO_NETWORK = "Preview";
