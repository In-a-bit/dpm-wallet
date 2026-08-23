import { Global, Module } from "@nestjs/common";

import { loadConfig, type Config } from "./config";
import { parseEncryptionKey } from "./crypto/credential-encryption";
import { setLogLevel } from "./observability/log";
import { CONFIG, ENCRYPTION_KEY } from "./tokens";

/**
 * Parses the environment once, at the top of the DI graph. A malformed value throws here and
 * takes the boot down with it, which is the point: a bad contract address or a short
 * encryption key must not surface on the first request instead.
 *
 * Global so that a feature module can inject CONFIG without importing this one, the way the
 * old `Runtime` object made config reachable from everywhere.
 */
@Global()
@Module({
  providers: [
    {
      provide: CONFIG,
      useFactory: (): Config => {
        const config = loadConfig();
        setLogLevel(config.logLevel);
        return config;
      },
    },
    {
      // Parsed at boot, so a malformed key fails the boot instead of the first write.
      provide: ENCRYPTION_KEY,
      useFactory: (config: Config) => parseEncryptionKey(config.encryptionKey),
      inject: [CONFIG],
    },
  ],
  exports: [CONFIG, ENCRYPTION_KEY],
})
export class AppConfigModule {}
