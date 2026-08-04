/**
 * ADR-028 §3 — the local `myai-marketplace validate`/`pack` contract.
 *
 * Runs the SAME four checks `runtime/src/marketplace/publish.ts` runs
 * server-side (schema, capability-surface, semver/immutability, injection
 * scan) — imported directly from that module, not reimplemented, so the
 * local CLI and the server-side re-check can never drift (ADR-028 §3's own
 * risk callout: "local validator and server-side review drift").
 *
 * Per ADR-028 §3: "Local validation is advisory-fast; it cannot be the
 * security boundary... review at in_review → approved remains mandatory
 * even for a package that passes local validation clean." This module never
 * talks to the network or the review queue — it only reads a package
 * directory off disk and reports pass/fail, exactly what a creator runs
 * before ever submitting.
 *
 * §4's "not a re-publish of an already-published version" half of check 3
 * needs the prior `ListingVersion` history, which only the server has — a
 * fully offline local run cannot know that, so this module validates semver
 * *format* only (passing an empty prior-versions list into the shared
 * `validateSemverImmutability` check, which degrades exactly to that).
 */
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  computeArtifactHash,
  validateManifestSchema,
  validateDeclaredToolsAllowlist,
  validateSemverImmutability,
  scanInjectionPatterns,
  type PublishManifest,
  type PublishCheck,
} from '../../marketplace/publish.js';

export interface LocalRejection {
  check: PublishCheck | 'package_anatomy';
  reason: string;
  details: string[];
}

export type LocalValidateResult =
  | { ok: true; manifest: PublishManifest; artifactContent: string; warnings: string[] }
  | { ok: false; rejection: LocalRejection };

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Concatenate a directory tree into one canonical string (relative path +
 * content per file, sorted) so a skill/ tree hashes deterministically
 * regardless of filesystem read order — same canonicalization ADR-028 §2
 * requires of `manifestHash`.
 */
async function readTreeCanonicalized(rootDir: string, dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  files.sort();
  const parts: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    parts.push(`--- ${relative(rootDir, file)} ---\n${content}`);
  }
  return parts.join('\n');
}

async function collectFiles(rootDir: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(rootDir, full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

interface LoadedPackage {
  raw: unknown;
  artifactContent: string;
}

/**
 * Package anatomy (ADR-028 §1): exactly one artifact — `agent.md` for
 * `kind: "agent"`, `skill/SKILL.md`-rooted tree for `kind: "skill"`. A
 * directory containing both or neither fails validation. This is folded
 * into check 1 (schema validity) per ADR-028 §3 item 1: "the referenced
 * artifact file(s) exist and match kind."
 */
async function loadPackage(
  packageDir: string,
): Promise<{ ok: true; pkg: LoadedPackage } | { ok: false; errors: string[] }> {
  const manifestPath = join(packageDir, 'marketplace.manifest.json');
  let raw: unknown;
  try {
    const manifestText = await readFile(manifestPath, 'utf8');
    raw = JSON.parse(manifestText);
  } catch (err) {
    return { ok: false, errors: [`could not read/parse marketplace.manifest.json: ${(err as Error).message}`] };
  }

  const agentPath = join(packageDir, 'agent.md');
  const skillDir = join(packageDir, 'skill');
  const skillMdPath = join(skillDir, 'SKILL.md');
  const [hasAgent, hasSkill] = await Promise.all([pathExists(agentPath), pathExists(skillDir)]);

  if (hasAgent && hasSkill) {
    return { ok: false, errors: ['package contains both agent.md and skill/ — exactly one artifact is required'] };
  }
  if (!hasAgent && !hasSkill) {
    return { ok: false, errors: ['package contains neither agent.md nor skill/ — exactly one artifact is required'] };
  }

  const kind = isRecord(raw) ? raw.kind : undefined;
  if (kind === 'agent' && !hasAgent) {
    return { ok: false, errors: ["manifest declares kind: 'agent' but agent.md is missing"] };
  }
  if (kind === 'skill' && !hasSkill) {
    return { ok: false, errors: ["manifest declares kind: 'skill' but skill/ is missing"] };
  }
  if (kind === 'agent' && hasSkill) {
    return { ok: false, errors: ["manifest declares kind: 'agent' but package ships skill/ instead of agent.md"] };
  }
  if (kind === 'skill' && hasAgent) {
    return { ok: false, errors: ["manifest declares kind: 'skill' but package ships agent.md instead of skill/"] };
  }

  let artifactContent: string;
  if (hasAgent) {
    artifactContent = await readFile(agentPath, 'utf8');
  } else {
    if (!(await pathExists(skillMdPath))) {
      return { ok: false, errors: ['skill/ is present but skill/SKILL.md is missing'] };
    }
    artifactContent = await readTreeCanonicalized(packageDir, skillDir);
  }

  return { ok: true, pkg: { raw, artifactContent } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Runs the four ADR-028 §3 checks, fail-fast, in order, against a package
 * directory on disk. Mirrors `publishSubmission` in publish.ts but reads
 * from the filesystem instead of a request body, and skips the
 * network-dependent half of check 3 (no prior-version history available
 * offline).
 */
export async function validateLocalPackage(packageDir: string): Promise<LocalValidateResult> {
  const loaded = await loadPackage(packageDir);
  if (!loaded.ok) {
    return { ok: false, rejection: { check: 'package_anatomy', reason: 'package anatomy check failed', details: loaded.errors } };
  }
  const { raw, artifactContent } = loaded.pkg;

  // manifestHash is legitimately `null` before the first `pack` (ADR-028 §2:
  // "Null at first-draft authoring time; the local pack step computes and
  // writes it in"). `validate` must be runnable in that pre-pack state, so
  // for schema-check purposes only (never written to disk — that's pack's
  // job) a null hash is treated as "will be computed correctly at pack
  // time." A present-but-WRONG hash still fails, same as publish.ts: that
  // means the artifact changed since the last `pack` and the manifest is
  // stale.
  const forSchemaCheck =
    isRecord(raw) && raw.manifestHash === null
      ? { ...raw, manifestHash: computeArtifactHash(artifactContent) }
      : raw;

  // Check 1: schema validity (also covers manifestHash-matches-bytes, when present).
  const schemaResult = validateManifestSchema(forSchemaCheck, artifactContent);
  if (!schemaResult.ok) {
    return { ok: false, rejection: { check: 'schema', reason: 'manifest failed schema validation', details: schemaResult.errors } };
  }
  const manifest = schemaResult.manifest;

  // Check 2: capability-surface bound — declaredTools ⊆ marketplace-exposable allowlist.
  const allowlistResult = validateDeclaredToolsAllowlist(manifest.capabilities.declaredTools);
  if (!allowlistResult.ok) {
    return {
      ok: false,
      rejection: {
        check: 'capability_surface',
        reason: 'declaredTools includes tool(s) outside the marketplace-exposable allowlist',
        details: allowlistResult.offending,
      },
    };
  }

  // Check 3: semver / immutability — offline, so format-only (no prior-version history).
  const semverResult = validateSemverImmutability(manifest.version, []);
  if (!semverResult.ok) {
    return { ok: false, rejection: { check: 'semver_immutability', reason: semverResult.reason, details: [] } };
  }

  // Check 4: injection-pattern scan (mirrors security-integrity agent's scan).
  const scanResult = scanInjectionPatterns(artifactContent, manifest.changelog);
  if (!scanResult.ok) {
    return {
      ok: false,
      rejection: {
        check: 'injection_scan',
        reason: 'injection-pattern hit(s) require justification in the changelog',
        details: scanResult.hits,
      },
    };
  }

  return { ok: true, manifest, artifactContent, warnings: scanResult.warnings };
}

export interface LocalPackResult {
  ok: true;
  manifestHash: string;
  manifestPath: string;
  warnings: string[];
}

export type PackOutcome = LocalPackResult | { ok: false; rejection: LocalRejection };

/**
 * `pack` (ADR-028 §3): only runs if `validate` passes clean or
 * warnings-only. Computes `manifestHash` over the artifact bytes and writes
 * it back into `marketplace.manifest.json` on disk — the resulting file is
 * what a future `marketplace_publish` MCP tool accepts as its request body.
 * No network calls, no submission.
 */
export async function packLocalPackage(packageDir: string): Promise<PackOutcome> {
  const validated = await validateLocalPackage(packageDir);
  if (!validated.ok) return validated;

  const manifestHash = computeArtifactHash(validated.artifactContent);
  const manifestPath = join(packageDir, 'marketplace.manifest.json');
  const updatedManifest = { ...validated.manifest, manifestHash };
  await writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, 'utf8');

  return { ok: true, manifestHash, manifestPath, warnings: validated.warnings };
}
