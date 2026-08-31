import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Exempts a route from the API-key guard. Only health carries it, matching the
 * prediction-gateway convention that an orchestrator's probe needs no credential.
 *
 * It clears the route's security requirement in the OpenAPI document too. The document requires
 * the API key globally, so without this the docs would claim a credential is needed where the
 * guard waves the request through — and the two could only drift in the direction of a lie.
 * A route that also carries its own `@ApiOperation` overrides this and is documented as
 * requiring the key; that is cosmetic, not a hole, since the guard is what actually decides.
 */
export const Public = () =>
  applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), ApiOperation({ security: [] }));
