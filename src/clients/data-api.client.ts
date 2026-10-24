import type { Config } from "../config";
import { DpmwError } from "../errors";
import { platformIdentityHeaders } from "./platform-identity";
import { upstreamSignal } from "./upstream-timeout";

/** One address's collateral balance as data-api indexes it. */
export type CollateralBalance = {
  user: string;
  decimals: number;
  balanceRaw: string;
  balance: number;
  blockNumber?: number;
  updatedAt?: string;
};

/**
 * The data-api client. Balances are read from the indexer rather than the chain, so the
 * install needs no RPC of its own; data-api accepts the same owner credential the install
 * already holds, and scopes the answer to the addresses that owner onboarded.
 */
export class DataApiClient {
  constructor(
    private readonly config: Config["dataApi"],
    private readonly identity: { builderApiKey: string; lpApiKey?: string },
  ) {}

  /** Rows come back in request order. */
  async batchBalances(addresses: string[]): Promise<CollateralBalance[]> {
    if (!this.config.baseUrl) {
      throw new DpmwError("BALANCES_UNAVAILABLE", "DATA_API_URL is not configured");
    }
    const path = "/balances/batch-get";
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...platformIdentityHeaders(this.identity) },
        body: JSON.stringify({ users: addresses }),
        signal: upstreamSignal(),
      });
    } catch (cause) {
      throw new DpmwError("RELAYER_REQUEST_FAILED", `data-api ${path} is unreachable`, { cause });
    }
    if (!response.ok) {
      throw new DpmwError(
        "RELAYER_REQUEST_FAILED",
        `data-api ${path} failed with ${response.status}`,
        {
          internal: await errorText(response),
        },
      );
    }
    try {
      return (await response.json()) as CollateralBalance[];
    } catch (cause) {
      throw new DpmwError("RELAYER_REQUEST_FAILED", "data-api returned a malformed response", {
        cause,
      });
    }
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
