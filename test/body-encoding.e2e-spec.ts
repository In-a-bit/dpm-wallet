import { gzipSync } from "node:zlib";

import request from "supertest";

import { startHarness, type Harness } from "../src/testing/harness";
import { TEST_API_KEY } from "../src/testing/env";

/**
 * Compressed request bodies are refused before any guard runs: inflating attacker-controlled
 * input ahead of authentication is the body-parser advisory GHSA-27r3-jxmh-p828, and no caller
 * of this service compresses its (small, signed) payloads.
 */
describe("request body encoding", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("rejects a gzip-encoded body with 415", async () => {
    const response = await request(harness.app.getHttpServer())
      .post("/v1/addresses")
      .set("x-api-key", TEST_API_KEY)
      .set("content-type", "application/json")
      .set("content-encoding", "gzip")
      .send(gzipSync(JSON.stringify({ ref: "customer-12345" })));

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("still accepts a plain JSON body", async () => {
    const response = await harness.post("/v1/addresses", { body: { ref: "customer-12345" } });

    // The vault is not initialised, which proves the body parsed and the handler ran.
    expect(response.body.error.code).toBe("VAULT_NOT_INITIALIZED");
  });
});
