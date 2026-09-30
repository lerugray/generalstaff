// Minimal JSON Schema checker for the cycle-result/v1 schema (the keywords it
// uses: type, const, enum, required, additionalProperties, properties, items,
// minLength, uniqueItems, pattern, $ref into $defs).

export type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minLength?: number;
  minimum?: number;
  uniqueItems?: boolean;
  pattern?: string;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
};

function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const m = schema.$ref.match(/^#\/\$defs\/(.+)$/);
  if (!m || !root.$defs?.[m[1]!]) throw new Error(`unresolved $ref ${schema.$ref}`);
  return root.$defs[m[1]!]!;
}

function typeOk(value: unknown, type: string | string[] | undefined): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === "integer") return typeof value === "number" && Number.isInteger(value);
    if (t === "null") return value === null;
    if (t === "array") return Array.isArray(value);
    if (t === "object") {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    return typeof value === t;
  });
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path = "$",
): string[] {
  const s = resolveRef(schema, root);
  const errors: string[] = [];
  if (s.const !== undefined && value !== s.const) {
    errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: value not in enum`);
  if (!typeOk(value, s.type)) {
    errors.push(`${path}: type mismatch`);
    return errors;
  }
  if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: minimum`);
  if (typeof value === "string" && s.minLength !== undefined && value.length < s.minLength) {
    errors.push(`${path}: minLength`);
  }
  if (typeof value === "string" && s.pattern !== undefined && !new RegExp(s.pattern).test(value)) {
    errors.push(`${path}: pattern`);
  }
  if (Array.isArray(value) && s.items) {
    if (s.uniqueItems) {
      const seen = new Set(value.map((x) => JSON.stringify(x)));
      if (seen.size !== value.length) errors.push(`${path}: uniqueItems`);
    }
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, s.items!, root, `${path}[${i}]`));
    });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value) && s.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in s.properties)) errors.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, child] of Object.entries(s.properties)) {
      if (key in obj) {
        errors.push(...validateAgainstSchema(obj[key], child, root, `${path}.${key}`));
      }
    }
  }
  return errors;
}
