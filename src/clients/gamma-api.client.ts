import type { Address, Hex } from "viem";

import type { Config } from "../config";
import { DpmwError } from "../errors";
import { BUILDER_API_PRIVATE_KEY_HEADER } from "../sdk/builder-key-fetch";

/** The app-level key every gamma-api route is behind, custody onboarding included. */
export const APP_API_KEY_HEADER = "X-API-Key";

/** The pair gamma-api's custody onboarding takes: the EOA, and its proof of control. */
export type CustodyRegistration = {
  address: Address;
  signature: Hex;
};

/** What gamma-api reports for an onboarded address: the address, and the proxy it derived. */
export type CustodyUser = {
  address: Address;
  proxyWallet: Address;
};

/**
 * Onboards an address this install custodies into the DPM platform's user table, which is what
 * makes a RelayHub nonce resolvable for it — and therefore what every meta-transaction depends
 * on. Idempotent per address upstream: one already onboarded under this builder comes back
 * rather than erroring.
 */
export interface CustodyUserRegistrar {
  registerCustodyUser(registration: CustodyRegistration): Promise<CustodyUser>;
}

/**
 * The gamma-api client. Separate from `DpmApiClient` because these are two services on two
 * ports with two different auth stacks, however similar the names look: dpm-api holds the
 * Turnkey control plane, gamma-api holds the platform's user table.
 */
export class GammaApiClient implements CustodyUserRegistrar {
  constructor(private readonly config: Config["gammaApi"]) {}

  async registerCustodyUser(registration: CustodyRegistration): Promise<CustodyUser> {
    const path = "/custody/users";
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        // Both, always: the app key satisfies the global middleware and the builder secret the
        // custody group. Either one alone is a 401 whose body says only "unauthorized".
        headers: {
          "Content-Type": "application/json",
          [APP_API_KEY_HEADER]: this.config.appApiKey,
          [BUILDER_API_PRIVATE_KEY_HEADER]: this.config.builderApiKey,
        },
        body: JSON.stringify({
          address: registration.address,
          signature: registration.signature,
        }),
      });
    } catch (cause) {
      throw new DpmwError("RELAYER_REQUEST_FAILED", `gamma-api ${path} is unreachable`, { cause });
    }

    if (!response.ok) {
      const detail = `gamma-api ${path} failed with ${response.status}: ${await errorText(response)}`;
      // A refusal is a standing answer — the address belongs to another builder, this builder
      // is not a custody one, the credentials are wrong — so it is worth telling apart from a
      // platform that merely broke. Only the second is worth retrying.
      throw response.status < 500
        ? new DpmwError("DPM_REGISTRATION_REJECTED", detail)
        : new DpmwError("RELAYER_REQUEST_FAILED", detail);
    }
    return readCustodyUser(await parseJson(response));
  }
}

type CustodyUserBody = Partial<Record<"address" | "proxy_wallet", string>>;

function readCustodyUser(payload: unknown): CustodyUser {
  const body = payload as CustodyUserBody;
  if (!body?.address || !body.proxy_wallet) {
    throw new DpmwError("RELAYER_REQUEST_FAILED", "gamma-api returned an incomplete custody user");
  }
  return { address: body.address as Address, proxyWallet: body.proxy_wallet as Address };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new DpmwError("RELAYER_REQUEST_FAILED", "gamma-api returned a malformed response", {
      cause,
    });
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "<unreadable>";
  }
}
