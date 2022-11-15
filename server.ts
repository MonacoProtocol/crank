import * as anchor from "@project-serum/anchor";

import { match } from "./app/matching_crank";
import { settle } from "./app/settlement_crank";
import { CRANK_TYPE, getCrankType } from "./app/types";
import { errorLog, log } from "./app/utils";
import { server_run_timeout } from "./settings/settings.json";

if (process.argv.length != 3) {
  console.error("Usage: npm run local-start <MATCH|SETTLE>");
  process.exit(1);
}

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const crankTypeString = process.argv[2];
const crankType: CRANK_TYPE = getCrankType(crankTypeString);

log(
  `${crankTypeString} crank starting for ${process.env.PROGRAM_TYPE} on ${process.env.ENVIRONMENT}`,
);

async function runCrank() {
  switch (crankType) {
    case CRANK_TYPE.MATCH:
      await match();
      break;
    case CRANK_TYPE.SETTLE:
      await settle();
      break;
    case CRANK_TYPE.UNKNOWN:
    default:
      log(`Unknown crank type: ${crankTypeString}`);
      process.exit(-1);
  }
}

async function run() {
  try {
    log("Cranking");
    await runCrank();
    log("Cranked!");
  } catch (e) {
    errorLog(`Exception running ${crankTypeString} crank: `, e);
  } finally {
    try {
      global.setTimeout(run, server_run_timeout);
    } catch (e) {
      errorLog(`Critical exception running ${crankTypeString} crank: `, e);
    }
  }
}

try {
  run();
} catch (e) {
  errorLog(`Critical exception running ${crankTypeString} crank: `, e);
}
