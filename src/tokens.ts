/**
 * Injection tokens for the collaborators that are not classes: interfaces, type aliases and
 * functions. Anything with a class to name is injected by that class instead.
 */
export const CONFIG = "CONFIG";
export const DB = "DB";
export const TRANSACTION = "TRANSACTION";
export const ENCRYPTION_KEY = "ENCRYPTION_KEY";
export const SIGNER_PROVIDER = "SIGNER_PROVIDER";
export const DPM_API = "DPM_API";
export const KEY_VAULT = "KEY_VAULT";

/**
 * Runs several repository writes as one unit, so a multi-row operation cannot leave the
 * volume half-written. Synchronous by necessity: better-sqlite3 transactions cannot span
 * an await, so any provider call must complete before the transaction opens.
 */
export type Transaction = <T>(work: () => T) => T;
