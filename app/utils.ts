import { AnchorProvider, getProvider, Program } from "@project-serum/anchor";
import { PublicKey } from "@solana/web3.js";

import { program_ids } from "../settings/settings.json";

const _programCache: Map<string, Program> = new Map<string, Program>();

export function getAnchorProvider(): AnchorProvider {
  return getProvider() as AnchorProvider;
}

export async function findPdaWithSeeds(
  seeds: (Buffer | Uint8Array)[],
  programId: PublicKey,
) {
  const [pda] = await PublicKey.findProgramAddress(seeds, programId);
  return pda;
}

export async function getCoreProgram() {
  const cluster = process.env.ENVIRONMENT as string;
  const programType = process.env.PROGRAM_TYPE as string;
  try {
    const programId = program_ids[cluster][programType] as string;
    let program = _programCache.get(programId);
    if (program === undefined) {
      const provider = getAnchorProvider();
      const coreProgramPK = new PublicKey(programId);
      program = await Program.at(coreProgramPK, provider);
      _programCache.set(programId, program);
    }
    return program;
  } catch (e) {
    console.error(`Problem loading ${programType} program for ${cluster}`, e);
    throw e;
  }
}

function logString(msg: string): string {
  return `${new Date().toISOString()} - [${process.pid}] - ${msg}`;
}

export function log(msg: string, ...args: unknown[]) {
  if (args.length == 0) console.log(logString(msg));
  else console.log(logString(msg), args);
}

export function errorLog(msg: string, ...args: unknown[]) {
  if (args.length == 0) console.error(logString(msg));
  else console.error(logString(msg), args);
}
