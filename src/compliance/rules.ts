import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ToolMeta, ToolSpec } from '../tools/factory.js';
import {
  INVISIBLE_RANGES,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
} from '../tools/untrusted.js';

// Directory-compliance rules R1-R13 (ADR-0001-D7, ADR-0001-D2; SEC-01, SEC-02).
// Pure functions over tool specs, so the same rules run against the production
// registry and against deliberately bad fixtures. Not part of the build output
// (tsconfig.build.json excludes src/compliance).

export type RuleId =
  | 'R1'
  | 'R2'
  | 'R3'
  | 'R4'
  | 'R5'
  | 'R6'
  | 'R7'
  | 'R8'
  | 'R9'
  | 'R10'
  | 'R11'
  | 'R12'
  | 'R13';

export interface Violation {
  rule: RuleId;
  tool: string;
  message: string;
}

export interface CheckOptions {
  /** The production registry is read-only in v1 (R4, ADR-0001-D2). */
  production?: boolean;
}

/**
 * Read-only upstream POST routes (R7), each with its recorded reason.
 *
 * '/book_check/{location_id}' (D-04): the route validates the appointments it
 * is sent and nothing else. An empty 201 means bookable, a 422 lists why not,
 * and it creates no record and no hold (backend code read in full in
 * 02-RESEARCH, "book_check is validation only"; confirmed live by the "D-04"
 * test in src/booking/__tests__/client.live.test.ts, plan 02-09).
 */
export const READ_ONLY_POST_ROUTES: ReadonlySet<string> = new Set<string>([
  '/book_check/{location_id}',
]);

const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const CATCH_ALL_INPUTS: ReadonlySet<string> = new Set([
  'method',
  'http_method',
  'verb',
  'operation',
  'action',
  'endpoint',
]);
const PAGINATION_KEYS = [
  'page',
  'page_size',
  'returned',
  'total',
  'has_more',
  'next_page',
] as const;

// Description deny-list (research A9; first version, tune in Phase 2). All
// case-insensitive and without the g flag, so .test() carries no state.
export const DESCRIPTION_DENY_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|override)\b.{0,40}\b(instruction|system|previous|prior)/i,
  /\byou (must|should|shall|need to|have to)\b/i,
  /\b(always|never)\s+(call|use|invoke|run|ask|tell|respond|reply|answer)\b/i,
  /\b(call|use|invoke)\s+(the\s+)?[a-z_]+\s+(first|before|after|instead)\b/i,
  /\b(do not|don't|never)\s+(tell|mention|reveal|show|inform)\b/i,
  /\b(system prompt|developer message|hidden instruction)\b/i,
  /<\/?\s*(system|instructions?|important)\b|<<<|\[\/?INST\]/i,
  /https?:\/\//i,
  /[A-Za-z0-9+/]{40,}={0,2}/,
];

// PII input names, matched against the snake_case form of a property name, and
// PII wording, matched against property descriptions (research A9).
const PII_NAME_PATTERN =
  /(^|_)(phone|mobile|msisdn|tel|sms|otp|passcode|pin|password|email|first_name|last_name|full_name|client_name|customer_name|surname|birth|dob|national_id|passport|ssn|tax_id|card|cvv|iban)(_|$)/i;
const PII_TEXT_PATTERN =
  /\b(phone number|sms|verification code|one-time (code|password)|otp|e-?mail address|full name|date of birth|passport|national id)\b/i;

// Invisible and bidirectional characters. The ranges are imported from
// src/tools/untrusted.ts (INVISIBLE_RANGES), so the sanitiser and this gate
// cannot drift. Written with \u{...} escapes and the u flag (the Tag block is
// astral), so this file holds none of the characters.
function invisibleClass(flags: string): RegExp {
  const hex = (codePoint: number): string => `\\u{${codePoint.toString(16)}}`;
  const body = INVISIBLE_RANGES.map(([from, to]) =>
    from === to ? hex(from) : `${hex(from)}-${hex(to)}`
  ).join('');
  return new RegExp(`[${body}]`, flags);
}
const HAS_INVISIBLE = invisibleClass('u');
const ALL_INVISIBLE = invisibleClass('gu');

// Routes v1 never calls (ADR-0001-D2). Built from parts so that neither this
// file nor a grep for the routes finds them here.
const FORBIDDEN_ROUTES: readonly string[] = [
  ['book', 'record'].join('_'),
  ['book', 'code'].join('_'),
  ['', 'user', 'auth'].join('/'),
];
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '__tests__',
  'compliance',
]);

/**
 * Problems with text a host or model reads (tool descriptions, server
 * instructions): invisible characters, then the deny-list on the visible text.
 * `allowOwnFence` lets the server's own UNTRUSTED markers through; only the
 * server instructions, which name them, need that.
 */
export function textViolations(
  text: string,
  options: { allowOwnFence?: boolean } = {}
): string[] {
  const problems: string[] = [];
  if (HAS_INVISIBLE.test(text)) {
    problems.push('contains invisible or bidirectional control characters');
  }
  let visible = text.replace(ALL_INVISIBLE, '');
  if (options.allowOwnFence === true) {
    visible = visible
      .split(UNTRUSTED_OPEN)
      .join(' ')
      .split(UNTRUSTED_CLOSE)
      .join(' ');
  }
  for (const pattern of DESCRIPTION_DENY_PATTERNS) {
    if (pattern.test(visible)) {
      problems.push(`matches the deny pattern ${String(pattern)}`);
    }
  }
  return problems;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snakeTokens(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function elements(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

// Visits every property of a JSON Schema at any depth: properties, items,
// additionalProperties, composition keywords and definitions.
function walkProperties(
  node: unknown,
  path: string,
  visit: (name: string, schema: Json, path: string) => void,
  seen: Set<unknown> = new Set()
): void {
  if (!isRecord(node) || seen.has(node)) {
    return;
  }
  seen.add(node);
  if (isRecord(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      const childPath = path === '' ? name : `${path}.${name}`;
      if (isRecord(child)) {
        visit(name, child, childPath);
      }
      walkProperties(child, childPath, visit, seen);
    }
  }
  const nested: unknown[] = [
    node.items,
    node.additionalProperties,
    node.not,
    ...elements(node.items),
    ...elements(node.prefixItems),
    ...elements(node.anyOf),
    ...elements(node.oneOf),
    ...elements(node.allOf),
    ...(isRecord(node.$defs) ? Object.values(node.$defs) : []),
    ...(isRecord(node.definitions) ? Object.values(node.definitions) : []),
  ];
  for (const child of nested) {
    walkProperties(child, path, visit, seen);
  }
}

function hasStringKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    keys.every((key) => (value as unknown[]).includes(key))
  );
}

interface AjvLike {
  compile(schema: object): unknown;
}
type AjvConstructor = new (options: {
  strict: boolean;
  validateFormats: boolean;
}) => AjvLike;

// ajv is CommonJS. Under NodeNext the default import is typed as the module
// object, and at run time it is the constructor (Node ESM) or the module with
// a default property (Jest's CommonJS transform), so accept both.
function ajvConstructor(): AjvConstructor {
  const imported: unknown = Ajv2020;
  const candidate =
    typeof imported === 'function'
      ? imported
      : (imported as { default: unknown }).default;
  return candidate as AjvConstructor;
}

function compiles(schema: unknown): string | null {
  try {
    const Ctor = ajvConstructor();
    new Ctor({ strict: false, validateFormats: false }).compile(
      schema as object
    );
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'does not compile';
  }
}

function ruleNumber(rule: RuleId): number {
  return Number(rule.slice(1));
}

function sorted(violations: Violation[]): Violation[] {
  return violations.sort(
    (a, b) =>
      ruleNumber(a.rule) - ruleNumber(b.rule) ||
      (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0) ||
      (a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
  );
}

export function checkTool(
  spec: ToolSpec,
  meta: ToolMeta,
  options: CheckOptions = {}
): Violation[] {
  const tool = String(spec.name);
  const out: Violation[] = [];
  const add = (rule: RuleId, message: string): void => {
    out.push({ rule, tool, message });
  };
  // Fixtures may be deliberately malformed, so read through a loose view.
  const annotations: Partial<Record<string, unknown>> = isRecord(
    spec.annotations
  )
    ? spec.annotations
    : {};
  const inputSchema: Json = isRecord(spec.inputSchema) ? spec.inputSchema : {};

  // R1 title
  if (
    typeof spec.title !== 'string' ||
    spec.title.trim() === '' ||
    spec.title !== annotations.title
  ) {
    add('R1', 'title is missing or differs from annotations.title');
  }

  // R2 hints
  for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
    if (typeof annotations[hint] !== 'boolean') {
      add('R2', `annotations.${hint} must be a boolean`);
    }
  }

  // R3 consistency
  if (
    annotations.readOnlyHint === true &&
    annotations.destructiveHint === true
  ) {
    add('R3', 'a tool cannot be both read-only and destructive');
  }

  // R4 v1 policy
  if (options.production === true && annotations.readOnlyHint !== true) {
    add('R4', 'every production tool must be read-only in v1');
  }

  // R5 name
  if (
    typeof spec.name !== 'string' ||
    spec.name.length > MAX_NAME_CHARS ||
    !NAME_PATTERN.test(spec.name)
  ) {
    add(
      'R5',
      `name must be <domain>_<verb>[_object] in [a-z0-9_] and at most ${MAX_NAME_CHARS} characters`
    );
  }

  // R6 no catch-all input (top-level properties)
  const topProperties = isRecord(inputSchema.properties)
    ? Object.keys(inputSchema.properties)
    : [];
  for (const property of topProperties) {
    if (CATCH_ALL_INPUTS.has(property.toLowerCase())) {
      add('R6', `input "${property}" makes this a catch-all tool`);
    }
  }

  // R7 declared upstream calls of a read-only tool
  if (annotations.readOnlyHint === true) {
    for (const call of meta.upstream) {
      const allowed =
        call.method === 'GET' ||
        (call.method === 'POST' && READ_ONLY_POST_ROUTES.has(call.route));
      if (!allowed) {
        add(
          'R7',
          `read-only tool declares ${call.method} ${call.route}, which is not an allowed read`
        );
      }
    }
  }

  // R8 description
  const description: unknown = spec.description;
  if (typeof description !== 'string' || description.trim() === '') {
    add('R8', 'description is empty');
  } else {
    if (description.length > MAX_DESCRIPTION_CHARS) {
      add(
        'R8',
        `description is longer than ${MAX_DESCRIPTION_CHARS} characters`
      );
    }
    for (const problem of textViolations(description)) {
      add('R8', `description ${problem}`);
    }
  }

  // R9 no personal data inputs, at any depth
  walkProperties(inputSchema, '', (name, schema, path) => {
    if (PII_NAME_PATTERN.test(snakeTokens(name))) {
      add('R9', `input "${path}" asks for personal data`);
    }
    if (
      typeof schema.description === 'string' &&
      PII_TEXT_PATTERN.test(schema.description)
    ) {
      add('R9', `the description of input "${path}" asks for personal data`);
    }
  });
  if (
    typeof inputSchema.description === 'string' &&
    PII_TEXT_PATTERN.test(inputSchema.description)
  ) {
    add('R9', 'the input description asks for personal data');
  }

  // R10 output schema
  const outputSchema: unknown = spec.outputSchema;
  if (!isRecord(outputSchema) || outputSchema.type !== 'object') {
    add('R10', 'outputSchema must be present with type object');
  } else {
    const problem = compiles(outputSchema);
    if (problem !== null) {
      add('R10', `outputSchema does not compile: ${problem}`);
    }
  }
  const inputProblem = compiles(inputSchema);
  if (inputProblem !== null) {
    add('R10', `inputSchema does not compile: ${inputProblem}`);
  }

  // R11 pagination shape for list tools
  if (meta.kind === 'list') {
    const properties = isRecord(inputSchema.properties)
      ? inputSchema.properties
      : {};
    for (const key of ['page', 'page_size']) {
      if (!(key in properties)) {
        add('R11', `list tool input needs ${key}`);
      }
    }
    const outputProperties =
      isRecord(outputSchema) && isRecord(outputSchema.properties)
        ? outputSchema.properties
        : {};
    const itemsSchema = outputProperties.items;
    if (!isRecord(itemsSchema) || itemsSchema.type !== 'array') {
      add('R11', 'list tool output needs an items array');
    }
    const pagination = outputProperties.pagination;
    if (
      !isRecord(pagination) ||
      pagination.type !== 'object' ||
      !hasStringKeys(pagination.required, PAGINATION_KEYS)
    ) {
      add(
        'R11',
        `list tool output needs a pagination object requiring ${PAGINATION_KEYS.join(', ')}`
      );
    }
  }

  // R13 strict input
  if (inputSchema.additionalProperties !== false) {
    add('R13', 'inputSchema.additionalProperties must be false');
  }

  return sorted(out);
}

export function checkRegistry(
  tools: readonly { spec: ToolSpec; meta: ToolMeta }[],
  options: CheckOptions = {}
): Violation[] {
  const out = tools.flatMap(({ spec, meta }) => checkTool(spec, meta, options));
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const { spec } of tools) {
    if (seen.has(spec.name) && !reported.has(spec.name)) {
      reported.add(spec.name);
      out.push({
        rule: 'R5',
        tool: spec.name,
        message: 'tool name is used more than once in the registry',
      });
    }
    seen.add(spec.name);
  }
  return sorted(out);
}

function sourceFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !SKIPPED_DIRECTORIES.has(entry.name) &&
        entry.name !== 'node_modules'
      ) {
        files.push(...sourceFiles(path));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** R12: no source file refers to the write or sign-in routes (SEC-02). */
export function scanForbiddenRoutes(rootDir: string): Violation[] {
  const out: Violation[] = [];
  for (const file of sourceFiles(rootDir)) {
    const text = readFileSync(file, 'utf8');
    const found = FORBIDDEN_ROUTES.filter((route) => text.includes(route));
    if (found.length > 0) {
      out.push({
        rule: 'R12',
        tool: relative(rootDir, file),
        message: `refers to a route v1 never calls: ${found.join(', ')}`,
      });
    }
  }
  return sorted(out);
}
