export enum CRANK_TYPE {
  MATCH,
  SETTLE,
  UNKNOWN,
}

export function getCrankType(arg: string): CRANK_TYPE {
  return arg == "MATCH"
    ? CRANK_TYPE.MATCH
    : arg == "SETTLE"
    ? CRANK_TYPE.SETTLE
    : CRANK_TYPE.UNKNOWN;
}
