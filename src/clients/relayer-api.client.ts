import type { SubmitTransactionRequest } from "@inabit-com/dpm-sdk/turnkey";

import type { Config } from "../config";
import { DpmwError } from "../errors";
import { platformIdentityHeaders } from "./platform-identity";

/**
 * The relayer-api client for submission and status. Both calls act for one signer, so the
 * identity headers always carry the address; the relayer scopes what it answers to the
 * addresses that owner onboarded, which is why a lookup needs the signer and not just an id.
 */
export class RelayerApiClient {
  constructor(
    private readonly config: Pick<Config["relayer"], "baseUrl">,
    private readonly identity: { builderApiKey: string; lpApiKey?: string },
  ) {}

  /** Returns the relayer's body unchanged: `{transactionID, transactionHash?, state}`. */
  async submit(request: SubmitTransactionRequest): Promise<Record<string, unknown>> {
    const response = await this.call("/submit", request.from, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    return this.parse(response, "/submit") as Promise<Record<string, unknown>>;
  }

  /** The relayer answers with an array; an empty one, like a 404, means it knows no such id. */
  async transaction(id: string, actingAddress: string): Promise<Record<string, unknown>> {
    const path = `/transaction?id=${encodeURIComponent(id)}`;
    const response = await this.call(path, actingAddress, { method: "GET" }, true);
    const rows = await this.parse(response, "/transaction");
    if (!Array.isArray(rows) || rows.length === 0) throw transactionNotFound(id);
    return rows[0] as Record<string, unknown>;
  }

  private async call(
    path: string,
    actingAddress: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    notFoundIsTransaction = false,
  ): Promise<Response> {
    const route = path.split("?")[0];
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, ...platformIdentityHeaders(this.identity, actingAddress) },
      });
    } catch (cause) {
      throw new DpmwError("RELAYER_REQUEST_FAILED", `relayer-api ${route} is unreachable`, {
        cause,
      });
    }
    if (notFoundIsTransaction && response.status === 404) {
      throw transactionNotFound(new URL(path, "http://x").searchParams.get("id") ?? "");
    }
    if (!response.ok) {
      throw new DpmwError(
        "RELAYER_REQUEST_FAILED",
        `relayer-api ${route} failed with ${response.status}: ${await errorText(response)}`,
      );
    }
    return response;
  }

  private async parse(response: Response, route: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (cause) {
      throw new DpmwError(
        "RELAYER_REQUEST_FAILED",
        `relayer-api ${route} returned a malformed response`,
        { cause },
      );
    }
  }
}

function transactionNotFound(id: string): DpmwError {
  return new DpmwError("RELAY_TRANSACTION_NOT_FOUND", `No relayed transaction "${id}"`, {
    details: { id },
  });
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
