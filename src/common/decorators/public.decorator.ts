import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Exempts a route from the API-key guard. Only health carries it, matching the
 * prediction-gateway convention that an orchestrator's probe needs no credential.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
