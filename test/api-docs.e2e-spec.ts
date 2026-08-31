import { API_KEY_SCHEME, buildApiDocument } from "../src/api-docs";
import { API_KEY_HEADER } from "../src/common/guards/api-key.guard";
import { startHarness, type Harness } from "../src/testing/harness";

/**
 * The Authorize dialog taking a key and then sending nothing is invisible from the server side —
 * the request simply arrives unauthenticated — so the document itself is what has to be asserted.
 */
describe("OpenAPI document", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("declares the API key as a header scheme under the name the guard reads", () => {
    const document = buildApiDocument(harness.app);
    expect(document.components?.securitySchemes?.[API_KEY_SCHEME]).toEqual({
      type: "apiKey",
      name: API_KEY_HEADER,
      in: "header",
    });
  });

  it("requires that scheme globally, which is what makes Swagger UI attach the header", () => {
    const document = buildApiDocument(harness.app);
    expect(document.security).toEqual([{ [API_KEY_SCHEME]: [] }]);
  });

  it("leaves a guarded route on the global requirement", () => {
    const document = buildApiDocument(harness.app);
    expect(document.paths["/v1/vault/status"]?.get?.security).toBeUndefined();
  });

  it("clears the requirement on the public health route, matching the guard", () => {
    const document = buildApiDocument(harness.app);
    expect(document.paths["/v1/health"]?.get?.security).toEqual([]);
  });
});
