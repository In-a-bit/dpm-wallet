/**
 * The complete set of error codes the operator gateway can receive, with the HTTP status
 * each maps to. Codes are part of the API contract: the gateway branches on them (a
 * `CUSTOMER_NOT_REGISTERED` is retried after registration, a `SIGNING_FAILED` is not), so
 * neither the string nor the status may change without a version bump.
 */
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  VALIDATION_FAILED: 400,
  VAULT_NOT_INITIALIZED: 409,
  ADDRESS_NOT_FOUND: 404,
  REF_ALREADY_EXISTS: 409,
  CUSTOMER_NOT_REGISTERED: 409,
  RELAYER_REQUEST_FAILED: 502,
  SIGNING_FAILED: 500,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};

/**
 * An error carrying a code the client is expected to act on. Anything thrown that is not
 * a DpmwError is treated as a bug and reported as INTERNAL_ERROR with its message
 * withheld, so an unexpected failure cannot leak internals through the envelope.
 */
export class DpmwError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DpmwError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options?.details) this.details = options.details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function unauthorized(message = "Missing or invalid API key"): DpmwError {
  return new DpmwError("UNAUTHORIZED", message);
}

export function validationFailed(message: string, details?: Record<string, unknown>): DpmwError {
  return new DpmwError("VALIDATION_FAILED", message, details ? { details } : undefined);
}

export function vaultNotInitialized(): DpmwError {
  return new DpmwError(
    "VAULT_NOT_INITIALIZED",
    "Vault is not initialized; call POST /v1/vault/init first",
  );
}

export function addressNotFound(ref: string): DpmwError {
  return new DpmwError("ADDRESS_NOT_FOUND", `No address for ref "${ref}"`, {
    details: { ref },
  });
}

/**
 * A ref is the operator's own identifier for a wallet, so reusing one is a mistake on
 * their side rather than a request to look the existing wallet up — silently returning it
 * would let a bug map two customers onto one key.
 */
export function refAlreadyExists(ref: string): DpmwError {
  return new DpmwError("REF_ALREADY_EXISTS", `An address already exists for ref "${ref}"`, {
    details: { ref },
  });
}

export function customerNotRegistered(ref: string): DpmwError {
  return new DpmwError(
    "CUSTOMER_NOT_REGISTERED",
    `Wallet "${ref}" is not registered with DPM, so no relay payload is available`,
    { details: { ref } },
  );
}
