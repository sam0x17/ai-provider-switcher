/**
 * Request-body hygiene for Anthropic Messages requests that the router sends
 * to the OpenAI-compatible server's /v1/messages endpoint.
 *
 * Local engines (LM Studio's llama.cpp backend in particular) compile tool
 * JSON schemas into a sampling grammar and reject constructs the grammar
 * builder does not understand. The schema rules below remove those constructs
 * without changing the meaning of the tool for the model.
 */

export interface SanitizeOptions {
  dropMcpTools?: boolean;
}

/** JSON-schema keywords that are purely descriptive or unsupported by grammar builders. */
const DROP_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'examples',
  'default',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'readOnly',
  'writeOnly',
  'deprecated',
  'nullable',
]);

const KNOWN_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function sanitizeSchema(schema: any, depth = 0): any {
  if (Array.isArray(schema)) return schema.map((s) => sanitizeSchema(s, depth + 1));
  if (!schema || typeof schema !== 'object') return schema;
  if (depth > 40) return {};

  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYWORDS.has(key)) continue;
    switch (key) {
      case 'properties':
      case 'definitions':
      case '$defs': {
        const map: any = {};
        for (const [k, v] of Object.entries(value ?? {})) map[k] = sanitizeSchema(v, depth + 1);
        out[key] = map;
        break;
      }
      case 'items':
      case 'not':
      case 'if':
      case 'then':
      case 'else':
      case 'contains':
        out[key] = sanitizeSchema(value, depth + 1);
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
      case 'prefixItems':
        out[key] = Array.isArray(value) ? value.map((v) => sanitizeSchema(v, depth + 1)) : value;
        break;
      case 'const':
        // Grammar builders generally understand enum but not const.
        if (!('enum' in schema)) out.enum = [value];
        break;
      case 'type':
        if (Array.isArray(value)) {
          const types = value.filter((t) => typeof t === 'string' && KNOWN_TYPES.has(t));
          if (types.length === 1) out.type = types[0];
          else if (types.length > 1) out.type = types;
        } else if (typeof value === 'string' && KNOWN_TYPES.has(value)) {
          out.type = value;
        }
        break;
      default:
        out[key] = value;
    }
  }
  // A property list without an explicit type is an object.
  if (out.properties && out.type === undefined) out.type = 'object';
  if (out.enum && !Array.isArray(out.enum)) delete out.enum;
  return out;
}

export function sanitizeTools(tools: any[], options: SanitizeOptions): any[] {
  const kept = options.dropMcpTools ? tools.filter((t) => !(typeof t?.name === 'string' && t.name.startsWith('mcp__'))) : tools;
  return kept.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const out: any = { ...tool };
    if (out.input_schema && typeof out.input_schema === 'object') out.input_schema = sanitizeSchema(out.input_schema);
    delete out.cache_control;
    return out;
  });
}

/** Mutates and returns a copy of the request body suitable for the provider. */
export function sanitizeMessagesBody(body: any, options: SanitizeOptions = {}): any {
  if (!body || typeof body !== 'object') return body;
  const out: any = { ...body };
  // Device/session identifiers are meaningful to Anthropic only.
  delete out.metadata;
  if (Array.isArray(out.tools)) out.tools = sanitizeTools(out.tools, options);
  return out;
}

/** Rough token estimate for count_tokens replies (≈4 characters per token). */
export function estimateTokens(body: any): number {
  let chars = 0;
  const add = (v: unknown) => { if (v !== undefined) chars += JSON.stringify(v).length; };
  add(body?.system);
  add(body?.messages);
  add(body?.tools);
  return Math.max(1, Math.ceil(chars / 4));
}
