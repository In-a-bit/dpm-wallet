// Nest's DI, class-transformer and class-validator all read design-time type metadata,
// which only exists once this polyfill has been loaded.
import "reflect-metadata";
