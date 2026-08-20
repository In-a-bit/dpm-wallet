#!/usr/bin/env node
/**
 * Copies the SQL migrations into dist/. `tsc` emits only JavaScript, and the migrator
 * reads the .sql files and their journal at runtime, so the build is incomplete without
 * them — the container would boot against an empty database.
 */
import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "src/db/migrations");
const target = resolve(projectRoot, "dist/db/migrations");

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`copied migrations -> ${target}`);
