import * as anchor from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";

import { matchManually } from "./app/matching_crank";
import { settleManually } from "./app/settlement_crank";
import { CRANK_TYPE, getCrankType } from "./app/types";
import { errorLog, log } from "./app/utils";

if (process.argv.length != 4) {
  console.error("Usage: npm run crank <MATCH|SETTLE> <MARKET_ID>");
  process.exit(1);
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const crankType: CRANK_TYPE = getCrankType(process.argv[2]);
const marketPK = new PublicKey(process.argv[3]);

async function run() {
  log("Cranking");

  switch (crankType) {
    case CRANK_TYPE.MATCH:
      await matchManually(marketPK);
      break;
    case CRANK_TYPE.SETTLE:
      await settleManually(marketPK);
      break;
    case CRANK_TYPE.UNKNOWN:
    default:
      errorLog(`Unknown crank type: ${process.argv[2]}`);
  }

  log("Cranked!");
}

run();
