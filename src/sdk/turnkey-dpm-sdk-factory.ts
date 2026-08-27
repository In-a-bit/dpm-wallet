import { DpmSdk, getErrorCode } from "@inabit-com/dpm-sdk/turnkey";

import type { Config } from "../config";
import { DpmwError } from "../errors";
import { logInfo } from "../observability/log";
import type { ProviderAccess, SignerProvider } from "../vault/providers/signer-provider.interface";
import { BUILDER_API_PRIVATE_KEY_HEADER } from "./builder-key-fetch";
import type { SigningSdk, SigningSdkSource } from "./signing-sdk";

/**
 * The SDK's codes for a call that left the process and did not come back with an answer:
 * `NETWORK` never reached the host, the other two reached it and were refused. Reading the
 * contract addresses is the only such call `DpmSdk.create` makes, so these codes — and only
 * these — identify a failure that belongs upstream rather than to this install.
 */
const RELAYER_READ_FAILURE_CODES = new Set(["NETWORK", "RELAYER", "RELAYER_REJECTED"]);

/**
 * Builds the SDK the signing features share, once.
 *
 * Not built at boot: the sub-organisation credentials it needs arrive only when the vault is
 * initialised or rehydrated, which happens after the container is wired, and an uninitialised
 * install has none at all. So the first signing request builds it and every later one reuses
 * it — including the contract addresses, which are read from the relayer that once.
 *
 * The promise is what gets cached, not the SDK: two requests arriving together then share one
 * build instead of racing to open a second Turnkey client and read the addresses twice.
 *
 * A failed attempt is not cached. An install that is initialised after its first request, or
 * whose first attempt hit a relayer that was briefly down, must be able to succeed later.
 */
export class TurnkeyDpmSdkFactory implements SigningSdkSource {
  private sdkPromise: Promise<SigningSdk> | undefined;

  constructor(
    private readonly provider: SignerProvider,
    private readonly config: Config,
  ) {}

  async getSdk(): Promise<SigningSdk> {
    this.sdkPromise ??= this.build();
    try {
      return await this.sdkPromise;
    } catch (cause) {
      this.sdkPromise = undefined;
      throw cause;
    }
  }

  private async build(): Promise<SigningSdk> {
    const sdk = await this.create(this.provider.getCredentials());
    logInfo("sdk.initialized", {
      chainId: sdk.contractInfo.chainId,
      ctfExchange: sdk.contractInfo.ctfExchange,
      relayHub: sdk.contractInfo.relayHub,
    });
    return sdk;
  }

  /**
   * Classifying the failure here is what keeps it recognisable further out: the SDK's error
   * classes are bundled per entry point, so an `instanceof` check made against the ones a
   * caller imported would not match the ones raised in here.
   */
  private async create(access: ProviderAccess): Promise<SigningSdk> {
    try {
      return await DpmSdk.create({
        credentials: {
          apiBaseUrl: access.apiBaseUrl,
          subOrgId: access.subOrgId,
          apiPublicKey: access.apiPublicKey,
          apiPrivateKey: access.apiPrivateKey,
        },
        relayerBaseUrl: this.config.relayer.baseUrl,
        chainId: this.config.chainId,
        // relayer-api gates every route but /healthz, /metrics and /swagger/* — including
        // GET /contract-info, despite its "public" label in that service's router comment.
        contractInfoHeaders: {
          [BUILDER_API_PRIVATE_KEY_HEADER]: this.config.relayer.builderApiKey,
        },
      });
    } catch (cause) {
      throw translateCreateFailure(cause);
    }
  }
}

/**
 * Blaming the relayer takes evidence, since setting up the SDK is more than reading from it:
 * malformed credentials, a chain id it rejects and contract-info answered with fields missing
 * all fail in here too, and none of them is fixed by retrying. So an error only becomes
 * `RELAYER_REQUEST_FAILED` when its code says a call actually failed to get an answer;
 * anything else is this install's own to explain, and the SDK's message is what explains it.
 */
function translateCreateFailure(cause: unknown): DpmwError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const code = getErrorCode(cause);
  if (code && RELAYER_READ_FAILURE_CODES.has(code)) {
    return new DpmwError("RELAYER_REQUEST_FAILED", `contract-info failed: ${detail}`, { cause });
  }
  return new DpmwError("INTERNAL_ERROR", `signing SDK setup failed: ${detail}`, { cause });
}
