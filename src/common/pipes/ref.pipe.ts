import { Injectable, type PipeTransform } from "@nestjs/common";

import { validationFailed } from "../../errors";

const MAX_LENGTH = 128;

/**
 * Validates a wallet ref taken from the path. Body refs go through `@IsRef()`; this is the
 * same rule for the one place a ref arrives as a URL segment.
 */
@Injectable()
export class RefPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const ref = typeof value === "string" ? value.trim() : "";
    if (ref.length < 1 || ref.length > MAX_LENGTH) {
      throw validationFailed("Request validation failed", {
        issues: [{ path: "ref", message: `must be between 1 and ${MAX_LENGTH} characters` }],
      });
    }
    return ref;
  }
}
