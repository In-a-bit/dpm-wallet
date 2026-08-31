import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";

import { BASE_PATH } from "./app.setup";
import { API_KEY_HEADER } from "./common/guards/api-key.guard";

/** The name the document gives the scheme; only referenced from security requirements. */
export const API_KEY_SCHEME = "apiKey";

/**
 * Built apart from `mountApiDocs` so a test can assert what the document actually requires
 * rather than trusting the builder chain to read correctly.
 */
export function buildApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("dpm-wallet")
      .setDescription(
        "Operator-hosted address management and signing service for DPM prediction markets",
      )
      .setVersion("1")
      .addApiKey({ type: "apiKey", name: API_KEY_HEADER, in: "header" }, API_KEY_SCHEME)
      // Declaring the scheme only tells Swagger UI that a credential exists; it attaches one to a
      // request solely where an operation *requires* it. Without this the Authorize dialog took
      // the key and then sent nothing, which looks exactly like the key being ignored. Requiring
      // it globally also matches the guard, which is registered globally for the same reason:
      // a new controller is covered by default instead of by remembering. `@Public()` carries the
      // matching opt-out.
      .addSecurityRequirements(API_KEY_SCHEME)
      .build(),
  );
}

export function mountApiDocs(app: INestApplication): void {
  SwaggerModule.setup(`${BASE_PATH}/docs`, app, buildApiDocument(app));
}
