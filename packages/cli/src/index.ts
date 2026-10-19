#!/usr/bin/env node
/**
 * `ferry` CLI entry point.
 */
import { run } from './program.js';

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
