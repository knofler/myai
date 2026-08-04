#!/usr/bin/env node
/**
 * myai-marketplace — ADR-028 §3's local validation CLI (spec-only until
 * this file; implementation checklist item #1). Distribution (npm package
 * vs. bundled with the gateway) is explicitly deferred per ADR-028 §6 — this
 * is the Node script the eventual package/bin wrapper will invoke.
 *
 * Usage:
 *   myai-marketplace validate <package-dir>
 *   myai-marketplace pack <package-dir>
 */
import { validateLocalPackage, packLocalPackage, type LocalRejection } from './local-validate.js';

function printRejection(rejection: LocalRejection): void {
  console.error(`FAIL [${rejection.check}]: ${rejection.reason}`);
  for (const detail of rejection.details) console.error(`  - ${detail}`);
}

async function runValidate(packageDir: string): Promise<number> {
  const result = await validateLocalPackage(packageDir);
  if (!result.ok) {
    printRejection(result.rejection);
    return 1;
  }
  console.log(`OK — ${packageDir} passes all four ADR-028 §3 local checks.`);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  console.log('Reminder: local validation is advisory-fast, never authoritative — server-side review still applies.');
  return 0;
}

async function runPack(packageDir: string): Promise<number> {
  const result = await packLocalPackage(packageDir);
  if (!result.ok) {
    printRejection(result.rejection);
    return 1;
  }
  console.log(`OK — packed ${packageDir}`);
  console.log(`  manifestHash: ${result.manifestHash}`);
  console.log(`  manifest written: ${result.manifestPath}`);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, packageDir] = argv;
  if (!command || !packageDir || (command !== 'validate' && command !== 'pack')) {
    console.error('Usage: myai-marketplace <validate|pack> <package-dir>');
    return 2;
  }
  return command === 'validate' ? runValidate(packageDir) : runPack(packageDir);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
