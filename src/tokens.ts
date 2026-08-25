import type { Executor } from "./db/client";

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
 * database half-written. The executor handed to `work` is what makes that hold: every write
 * meant to be part of the transaction must be issued through it, because a write sent to the
 * pool instead runs on another connection and commits on its own.
 */
export type Transaction = <T>(work: (executor: Executor) => Promise<T>) => Promise<T>;
