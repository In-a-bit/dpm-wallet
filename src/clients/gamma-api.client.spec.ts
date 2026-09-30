import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { DpmwError } from "../errors";
import { GammaApiClient } from "./gamma-api.client";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const PROXY = "0x7Ccc0F3dAf403654e175FF0737eD21dC54EBB109";
const SIGNATURE = `0x${"ab".repeat(65)}` as const;

type Recorded = { path: string; headers: NodeJS.Dict<string | string[]>; body: string };

/**
 * gamma-api guards custody onboarding twice over: a global gate on every route, and the builder
 * secret on the custody group. The builder secret satisfies both; the platform-wide app key is
 * only for a gamma-api whose global gate predates that, so it is sent only when configured.
 */
describe("GammaApiClient.registerCustodyUser", () => {
  let server: Server;
  let baseUrl: string;
  const requests: Recorded[] = [];
  let respond: (res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", headers: req.headers, body });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    requests.length = 0;
    respond = (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ address: ADDRESS, proxy_wallet: PROXY }));
    };
  });

  const client = (appApiKey?: string): GammaApiClient =>
    new GammaApiClient({ baseUrl, appApiKey, builderApiKey: "bld_sk_test" });

  it("posts the attestation to custody onboarding and decodes the user", async () => {
    const user = await client().registerCustodyUser({ address: ADDRESS, signature: SIGNATURE });

    expect(user).toEqual({ address: ADDRESS, proxyWallet: PROXY });
    expect(requests.at(-1)?.path).toBe("/custody/users");
    expect(JSON.parse(requests.at(-1)?.body ?? "")).toEqual({
      address: ADDRESS,
      signature: SIGNATURE,
    });
  });

  // A new install holds no platform-wide credential at all: the builder secret is the whole
  // of its identity, and sending an empty X-API-Key would only muddy the gate's logs.
  it("presents only the builder secret when no app key is configured", async () => {
    await client().registerCustodyUser({ address: ADDRESS, signature: SIGNATURE });

    expect(requests.at(-1)?.headers["x-builder-api-private-key"]).toBe("bld_sk_test");
    expect(requests.at(-1)?.headers["x-api-key"]).toBeUndefined();
  });

  // An install configured before gamma-api accepted the builder secret keeps working.
  it("adds the app key when one is configured", async () => {
    await client("app_key_test").registerCustodyUser({ address: ADDRESS, signature: SIGNATURE });

    expect(requests.at(-1)?.headers["x-api-key"]).toBe("app_key_test");
    expect(requests.at(-1)?.headers["x-builder-api-private-key"]).toBe("bld_sk_test");
  });

  // gamma-api answers 409 when the address belongs to another builder. Retrying will not change
  // that, so it has to arrive as something other than the transport failure everything else
  // collapses into — the provisioning retry loop branches on exactly this distinction.
  it("reports a refused registration as DPM_REGISTRATION_REJECTED", async () => {
    respond = (res) => {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "address already registered under a different account" }));
    };

    const failure = await client()
      .registerCustodyUser({ address: ADDRESS, signature: SIGNATURE })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DpmwError);
    expect((failure as DpmwError).code).toBe("DPM_REGISTRATION_REJECTED");
    expect((failure as DpmwError).message).toContain("different account");
  });

  it("reports a broken platform as RELAYER_REQUEST_FAILED, which is worth retrying", async () => {
    respond = (res) => {
      res.writeHead(503);
      res.end("upstream restarting");
    };

    const failure = await client()
      .registerCustodyUser({ address: ADDRESS, signature: SIGNATURE })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DpmwError);
    expect((failure as DpmwError).code).toBe("RELAYER_REQUEST_FAILED");
  });
});
