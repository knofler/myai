#!/usr/bin/env node
/**
 * gen_sdk.mjs — generate typed client SDKs from the gateway OpenAPI document.
 *
 * Single source of truth for the wire contract is docs/reference/openapi.json
 * (materialised from buildOpenApiSpec() by scripts/gen_openapi.mjs). This
 * script reads that document and emits the *typed* parts of two client
 * libraries — the models and one method per operationId:
 *
 *   sdk/typescript/src/generated.ts     TS interfaces + GeneratedClient methods
 *   sdk/python/myai_gateway/_generated.py  Python TypedDicts + _GeneratedOps
 *
 * The hand-written runtime (auth, retry, transport) lives beside the generated
 * files and never changes when the spec does — so regenerating is safe.
 *
 *   node scripts/gen_sdk.mjs           # write the generated files
 *   node scripts/gen_sdk.mjs --check   # exit 1 if either file is stale (CI drift gate)
 *
 * Drift is guarded by scripts/tests/test_sdk_drift.sh (hermetic, node-only):
 * it runs --check and fails the build if the committed SDKs lag the spec.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(REPO_ROOT, 'docs', 'reference', 'openapi.json');
const TS_OUT = path.join(REPO_ROOT, 'sdk', 'typescript', 'src', 'generated.ts');
const PY_OUT = path.join(REPO_ROOT, 'sdk', 'python', 'myai_gateway', '_generated.py');

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const schemas = spec.components?.schemas ?? {};

// ---------- helpers ----------
const refName = (ref) => ref.split('/').pop();
const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();

// Deterministic ordering so output is stable across runs / platforms.
const sortedPaths = Object.keys(spec.paths).sort();
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete'];

/** Walk every operation in a stable order. */
function* operations() {
  for (const p of sortedPaths) {
    const item = spec.paths[p];
    for (const m of METHOD_ORDER) {
      if (item[m]) yield { path: p, method: m, op: item[m] };
    }
  }
}

/** Pick the success (2xx) response schema for an operation, or null for no content. */
function successResponse(op) {
  const responses = op.responses ?? {};
  const code = ['200', '201', '202'].find((c) => responses[c]) ?? null;
  if (!code) return { code: '204', schema: null };
  const schema = responses[code]?.content?.['application/json']?.schema ?? null;
  return { code, schema };
}

function requestBodySchema(op) {
  return op.requestBody?.content?.['application/json']?.schema ?? null;
}

function requiresAdmin(op) {
  return Array.isArray(op.security) && op.security.some((s) => 'AdminToken' in s);
}

// ================= TypeScript =================
function tsType(schema) {
  if (!schema) return 'unknown';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(tsType).join(' | ');
  switch (schema.type) {
    case 'string': return 'string';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'array': return `Array<${tsType(schema.items)}>`;
    case 'object':
      if (schema.properties) return tsObject(schema);
      return 'Record<string, unknown>';
    default: return 'unknown';
  }
}

function tsObject(schema) {
  const required = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties ?? {}).map(([k, v]) => {
    const opt = required.has(k) ? '' : '?';
    return `  ${JSON.stringify(k)}${opt}: ${tsType(v)};`;
  });
  return `{\n${props.join('\n')}\n}`;
}

function tsModels() {
  const out = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const doc = schema.description ? `/** ${schema.description} */\n` : '';
    out.push(`${doc}export interface ${name} ${tsObject(schema)}\n`);
  }
  return out.join('\n');
}

function tsNamedType(name, schema) {
  if (!schema) return null;
  if (schema.$ref) return null; // reference an existing model directly
  return `export type ${name} = ${tsType(schema)};\n`;
}

function tsMethods() {
  const named = [];
  const methods = [];
  for (const { path: p, method, op } of operations()) {
    const opId = op.operationId;
    const pathParams = (op.parameters ?? []).filter((x) => x.in === 'path');
    const queryParams = (op.parameters ?? []).filter((x) => x.in === 'query');
    const body = requestBodySchema(op);
    const { schema: respSchema } = successResponse(op);

    // Named request/response aliases for inline (non-$ref) schemas.
    let bodyType = null;
    if (body) {
      if (body.$ref) bodyType = refName(body.$ref);
      else { bodyType = `${pascal(opId)}Request`; named.push(tsNamedType(bodyType, body)); }
    }
    let respType = 'void';
    if (respSchema) {
      if (respSchema.$ref) respType = refName(respSchema.$ref);
      else { respType = `${pascal(opId)}Response`; named.push(tsNamedType(respType, respSchema)); }
    }

    // Assemble the single params object.
    const fields = [];
    for (const pp of pathParams) fields.push(`  ${pp.name}: ${tsType(pp.schema)};`);
    for (const qp of queryParams) fields.push(`  ${qp.name}?: ${tsType(qp.schema)};`);
    if (bodyType) fields.push(`  body: ${bodyType};`);
    const allOptional = pathParams.length === 0 && !bodyType;
    const paramsType = fields.length ? `{\n${fields.join('\n')}\n}` : 'Record<string, never>';
    const paramsArg = fields.length
      ? `params: ${paramsType}${allOptional ? ' = {}' : ''}`
      : '';

    // Path template with encoded params.
    const pathTemplate = p.replace(/\{(\w+)\}/g, (_, n) => `\${encodeURIComponent(String(params.${n}))}`);
    const query = queryParams.length
      ? `, query: { ${queryParams.map((q) => `${JSON.stringify(q.name)}: params.${q.name}`).join(', ')} }`
      : '';
    const bodyArg = bodyType ? `, body: params.body` : '';
    const adminArg = requiresAdmin(op) ? `, admin: true` : '';

    const doc = op.summary ? `  /** ${op.summary} */\n` : '';
    methods.push(
      `${doc}  ${opId}(${paramsArg}): Promise<${respType}> {\n` +
      `    return this._request<${respType}>({ method: ${JSON.stringify(method.toUpperCase())}, ` +
      `path: \`${pathTemplate}\`${query}${bodyArg}${adminArg} });\n` +
      `  }\n`
    );
  }
  return { named: named.filter(Boolean).join('\n'), methods: methods.join('\n') };
}

function renderTs() {
  const { named, methods } = tsMethods();
  return `/* eslint-disable */
// ---------------------------------------------------------------------------
// AUTO-GENERATED by scripts/gen_sdk.mjs from docs/reference/openapi.json.
// DO NOT EDIT BY HAND. Run \`node scripts/gen_sdk.mjs\` to regenerate.
// Spec: ${spec.info.title} v${spec.info.version} (OpenAPI ${spec.openapi})
// ---------------------------------------------------------------------------
import { Transport } from './client-core.js';

export const SPEC_VERSION = ${JSON.stringify(spec.info.version)};

// ---------- models ----------
${tsModels()}
// ---------- inline request/response types ----------
${named}
// ---------- operations ----------
/** Typed operations. One method per operationId; transport is inherited. */
export class GeneratedClient extends Transport {
${methods}}
`;
}

// ================= Python =================
function pyType(schema) {
  if (!schema) return 'Any';
  if (schema.$ref) return `"${refName(schema.$ref)}"`;
  if (schema.enum) return `Literal[${schema.enum.map((v) => JSON.stringify(v)).join(', ')}]`;
  if (schema.oneOf || schema.anyOf) return `Union[${(schema.oneOf ?? schema.anyOf).map(pyType).join(', ')}]`;
  switch (schema.type) {
    case 'string': return 'str';
    case 'integer': return 'int';
    case 'number': return 'float';
    case 'boolean': return 'bool';
    case 'array': return `List[${pyType(schema.items)}]`;
    case 'object':
      if (schema.properties) return 'Dict[str, Any]'; // nested inline objects stay loose
      return 'Dict[str, Any]';
    default: return 'Any';
  }
}

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
]);
const isValidPyIdent = (k) => /^[A-Za-z_]\w*$/.test(k) && !PY_KEYWORDS.has(k);

function pyModels() {
  const out = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const props = Object.entries(schema.properties ?? {});
    const doc = schema.description ? `    """${schema.description}"""\n` : '';
    if (!props.length) {
      out.push(`class ${name}(TypedDict, total=False):\n${doc}    pass\n`);
      continue;
    }
    // A field named after a Python keyword (e.g. `from`) can't be a class
    // attribute — emit the functional TypedDict form for the whole class.
    if (props.some(([k]) => !isValidPyIdent(k))) {
      const entries = props.map(([k, v]) => `    ${JSON.stringify(k)}: ${pyType(v)},`);
      out.push(`${name} = TypedDict("${name}", {\n${entries.join('\n')}\n}, total=False)\n`);
      continue;
    }
    const lines = props.map(([k, v]) => `    ${k}: ${pyType(v)}`);
    out.push(`class ${name}(TypedDict, total=False):\n${doc}${lines.join('\n')}\n`);
  }
  return out.join('\n');
}

function pyMethods() {
  const methods = [];
  for (const { path: p, method, op } of operations()) {
    const opId = op.operationId;
    const pyName = snake(opId);
    const pathParams = (op.parameters ?? []).filter((x) => x.in === 'path');
    const queryParams = (op.parameters ?? []).filter((x) => x.in === 'query');
    const body = requestBodySchema(op);

    // Python var name for a param, keeping reserved words legal (from -> from_).
    const pyParam = (raw) => { const s = snake(raw); return isValidPyIdent(s) ? s : `${s}_`; };

    const args = ['self'];
    for (const pp of pathParams) args.push(`${pyParam(pp.name)}: str`);
    if (body) args.push(`body: Dict[str, Any]`);
    if (queryParams.length) args.push('*'); // force query params to be keyword-only
    for (const qp of queryParams) args.push(`${pyParam(qp.name)}: Any = None`);

    const pathTemplate = p.replace(/\{(\w+)\}/g, (_, n) => `{${pyParam(n)}}`);
    const callArgs = [`"${method.toUpperCase()}"`, `f"${pathTemplate}"`];
    if (queryParams.length) {
      const q = queryParams.map((qp) => `"${qp.name}": ${pyParam(qp.name)}`).join(', ');
      callArgs.push(`query={${q}}`);
    }
    if (body) callArgs.push('body=body');
    if (requiresAdmin(op)) callArgs.push('admin=True');

    const doc = op.summary ? `        """${op.summary}"""\n` : '';
    methods.push(
      `    def ${pyName}(${args.join(', ')}) -> Any:\n` +
      `${doc}        return self._request(${callArgs.join(', ')})\n`
    );
  }
  return methods.join('\n');
}

function renderPy() {
  return `# ---------------------------------------------------------------------------
# AUTO-GENERATED by scripts/gen_sdk.mjs from docs/reference/openapi.json.
# DO NOT EDIT BY HAND. Run \`node scripts/gen_sdk.mjs\` to regenerate.
# Spec: ${spec.info.title} v${spec.info.version} (OpenAPI ${spec.openapi})
# ---------------------------------------------------------------------------
from __future__ import annotations

from typing import Any, Dict, List, Literal, TypedDict, Union

SPEC_VERSION = ${JSON.stringify(spec.info.version)}


# ---------- models ----------
${pyModels()}

# ---------- operations ----------
class _GeneratedOperations:
    """Typed operations mixed into MyaiGatewayClient. One method per operationId."""

    def _request(self, method: str, path: str, query: Dict[str, Any] | None = None,
                 body: Any = None, admin: bool = False) -> Any:  # pragma: no cover - overridden
        raise NotImplementedError

${pyMethods()}`;
}

// ================= drive =================
const targets = [
  { file: TS_OUT, content: renderTs() },
  { file: PY_OUT, content: renderPy() },
];

const check = process.argv.includes('--check');
let stale = false;
for (const { file, content } of targets) {
  const rel = path.relative(REPO_ROOT, file);
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current !== content) {
      stale = true;
      console.error(`DRIFT: ${rel} is out of sync with the OpenAPI spec.`);
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale) {
  console.error('\nRun `node scripts/gen_sdk.mjs` and commit the result.');
  process.exit(1);
}
if (check) console.log('SDKs are in sync with the OpenAPI spec.');
