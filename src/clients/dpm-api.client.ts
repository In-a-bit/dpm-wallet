import type { Config } from "../config";
import { DpmwError } from "../errors";
import { logInfo } from "../observability/log";
import { BUILDER_API_PRIVATE_KEY_HEADER } from "../sdk/builder-key-fetch";

/** The header a liquidity-provider install authenticates with instead of a builder secret. */
export const LP_API_KEY_HEADER = "X-LP-Api-Key";

export type CreateSubOrganizationRequest = {
  /** The compressed P-256 public key this install generated. */
  apiPublicKey: string;
  /** The name this install looks its HD wallet up by, so the sub-org's wallet matches. */
  walletName: string;
};

export type SubOrganization = {
  subOrgId: string;
  subOrgName: string;
  /** The HD wallet Turnkey created inside the sub-org; every account derives from it. */
  walletId: string;
};

/**
 * Creates this install's Turnkey sub-organisation. Only dpm-api holds the parent-org
 * credentials that can do it, which is the whole reason this call exists rather than the
 * install talking to Turnkey directly.
 */
export interface SubOrganizationCreator {
  createSubOrganization(request: CreateSubOrganizationRequest): Promise<SubOrganization>;
}

/**
 * The dpm-api client. One endpoint today, and deliberately not the DPM SDK: this is the
 * platform's own control-plane API, not the relayer surface the SDK wraps.
 *
 * The request is safe to retry. dpm-api recognises an install by the public key it sends
 * and answers with the sub-organisation that key already owns, so a retry after a crash
 * cannot mint a second one.
 */
export class DpmApiClient implements SubOrganizationCreator {
  constructor(private readonly config: Config["dpmApi"]) {}

  async createSubOrganization(request: CreateSubOrganizationRequest): Promise<SubOrganization> {
    const response = await this.post("/turnkey/sub-organizations", {
      api_public_key: request.apiPublicKey,
      wallet_name: request.walletName,
    });
    const subOrg = readSubOrganization(await parseJson(response));
    logInfo("dpm_api.sub_organization_ready", {
      subOrgId: subOrg.subOrgId,
      subOrgName: subOrg.subOrgName,
      // 200 rather than 201 means dpm-api served the sub-org this install already owns.
      existing: response.status === 200,
    });
    return subOrg;
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.identityHeader() },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new DpmwError("RELAYER_REQUEST_FAILED", `dpm-api ${path} is unreachable`, { cause });
    }
    if (!response.ok) {
      throw new DpmwError(
        "RELAYER_REQUEST_FAILED",
        `dpm-api ${path} failed with ${response.status}: ${await errorText(response)}`,
      );
    }
    return response;
  }

  /**
   * Which owner this install belongs to is decided entirely by which credential it holds:
   * an LP key when one is configured, otherwise the builder secret it already uses for the
   * relayer. dpm-api attributes the sub-organisation to whoever the key resolves to.
   */
  private identityHeader(): Record<string, string> {
    if (this.config.lpApiKey) return { [LP_API_KEY_HEADER]: this.config.lpApiKey };
    return { [BUILDER_API_PRIVATE_KEY_HEADER]: this.config.builderApiKey };
  }
}

type SubOrganizationBody = Partial<Record<"sub_org_id" | "sub_org_name" | "wallet_id", string>>;

function readSubOrganization(payload: unknown): SubOrganization {
  const body = payload as SubOrganizationBody;
  if (!body?.sub_org_id || !body.sub_org_name || !body.wallet_id) {
    throw new DpmwError(
      "RELAYER_REQUEST_FAILED",
      "dpm-api returned an incomplete sub-organization",
    );
  }
  return {
    subOrgId: body.sub_org_id,
    subOrgName: body.sub_org_name,
    walletId: body.wallet_id,
  };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DpmwError("RELAYER_REQUEST_FAILED", "dpm-api returned a malformed response", {
      cause,
    });
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
