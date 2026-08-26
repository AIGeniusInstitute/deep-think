/**
 * MCP Registry — 极简 OpenAPI/Swagger 解析器。
 *
 * 无外部依赖。支持 OpenAPI 3.x 与 Swagger 2.0 的核心字段，
 * 把每个 path+method 映射为一个候选 registry tool（inputSchema + httpBinding 预填）。
 *
 * 目标是「够用的导入预填」，不是完整 OpenAPI 规范实现：复杂 allOf/oneOf 仅取
 * 第一个 schema，$ref 仅在本文档内解析。
 */

import type { HttpBinding, InputSchemaObject } from './engine.js';

export interface CandidateTool {
  name: string;
  description: string;
  inputSchema: InputSchemaObject;
  httpBinding: HttpBinding;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  parameters?: OpenApiParameter[];
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    description?: string;
    content?: Record<string, { schema?: OpenApiSchema; example?: unknown }>;
  };
  responses?: Record<string, { description?: string }>;
}

interface OpenApiParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: (string | number)[];
  default?: unknown;
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  $ref?: string;
}

function deref(doc: any, schema: OpenApiSchema | undefined): OpenApiSchema {
  if (!schema) return {};
  if (!schema.$ref) return schema;
  // #/components/schemas/Foo  →  doc.components.schemas.Foo
  const parts = schema.$ref.split('/').filter((p) => p && p !== '#');
  let cur: any = doc;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined) return {};
  }
  return cur as OpenApiSchema;
}

function schemaToJsonSchema(schemaIn: OpenApiSchema, doc: any, depth = 0): Record<string, unknown> {
  if (depth > 6) return { type: 'string' };
  const s = deref(doc, schemaIn);
  if (!s || typeof s !== 'object') return { type: 'string' };
  // 复合类型简化
  if (s.type === 'array' && s.items) {
    return { type: 'array', items: schemaToJsonSchema(s.items, doc, depth + 1) };
  }
  if (s.type === 'object' && s.properties) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties)) {
      props[k] = schemaToJsonSchema(v as OpenApiSchema, doc, depth + 1);
    }
    return {
      type: 'object',
      properties: props,
      ...(s.required ? { required: s.required } : {}),
    };
  }
  const out: Record<string, unknown> = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.default !== undefined) out.default = s.default;
  if (s.format) out.format = s.format;
  return out;
}

/** 把 operationId / summary 转为合法 tool name。 */
function toToolName(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  let n = raw
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[0-9]+/, '')
    .replace(/^_+|_+$/g, '');
  if (!n) n = fallback;
  if (/^[0-9]/.test(n)) n = `_${n}`;
  return n;
}

function methodHasBody(method: string): boolean {
  return ['post', 'put', 'patch'].includes(method.toLowerCase());
}

const ALLOWED_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * 解析一个 OpenAPI/Swagger 文档为候选 tool 列表。
 * baseUrl 用于 httpBinding.url（OpenAPI servers[0] 或绝对路径前缀拼接）。
 */
export function parseOpenApi(
  docRaw: string,
  opts: { baseUrl?: string; includePaths?: string[] } = {},
): { tools: CandidateTool[]; error?: string } {
  let doc: any;
  try {
    doc = JSON.parse(docRaw);
  } catch {
    return { tools: [], error: 'Invalid JSON document' };
  }
  if (!doc || typeof doc !== 'object') {
    return { tools: [], error: 'Document is not a JSON object' };
  }
  // Swagger 2.0 兼容：basePath + paths
  const isSwagger2 = doc.swagger && String(doc.swagger).startsWith('2');
  const paths = doc.paths;
  if (!paths || typeof paths !== 'object') {
    return { tools: [], error: 'Missing paths object (not an OpenAPI/Swagger doc)' };
  }

  // 基础 URL 解析：显式传入的 baseUrl 优先；否则取 OpenAPI 3 servers[0].url；
  // Swagger 2.0 用 basePath（相对，调用方应通过 baseUrl 给出 host）。
  let baseUrl = opts.baseUrl ?? '';
  if (!baseUrl && !isSwagger2 && Array.isArray(doc.servers) && doc.servers[0]?.url) {
    baseUrl = doc.servers[0].url;
  }
  if (!baseUrl && isSwagger2 && doc.basePath) {
    baseUrl = doc.basePath;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  const include = opts.includePaths;
  const pathMatches = (p: string) =>
    !include || include.some((ip) => p === ip || p.startsWith(ip));

  const tools: CandidateTool[] = [];
  for (const [path, itemRaw] of Object.entries(paths)) {
    if (!pathMatches(path)) continue;
    const item = itemRaw as OpenApiPathItem;
    if (!item || typeof item !== 'object') continue;
    // path 级公共 parameters
    const pathParams = item.parameters ?? [];

    for (const method of ALLOWED_METHODS) {
      const op = (item as Record<string, OpenApiOperation | undefined>)[method] as OpenApiOperation | undefined;
      if (!op) continue;

      const inputSchema: InputSchemaObject = { type: 'object', properties: {}, required: [] };
      const paramMapping: HttpBinding['paramMapping'] = {};
      const headers: Record<string, string> = {};
      let bodySchema: OpenApiSchema | undefined;

      // parameters: path 级 + op 级
      const allParams = [...pathParams, ...(op.parameters ?? [])];
      for (const p of allParams) {
        if (!p || !p.name) continue;
        const target = p.in === 'path' ? 'path' : p.in === 'query' ? 'query' : p.in === 'header' ? 'header' : null;
        if (!target) continue;
        (paramMapping as any)[target] = (paramMapping as any)[target] ?? {};
        (paramMapping as any)[target][p.name] = p.name;
        const js = schemaToJsonSchema(p.schema ?? { type: 'string' }, doc);
        inputSchema.properties![p.name] = js;
        if (p.required) inputSchema.required!.push(p.name);
        if (p.description && !js.description) (inputSchema.properties![p.name] as any).description = p.description;
      }

      // requestBody
      if (op.requestBody && methodHasBody(method)) {
        const json = op.requestBody.content?.['application/json'];
        const schema = json?.schema;
        if (schema) {
          const derefSchema = deref(doc, schema);
          if (derefSchema.properties) {
            // 把 body schema 的顶层 properties 展平为 inputSchema 参数 + body 映射
            paramMapping.body = {};
            for (const [k, v] of Object.entries(derefSchema.properties)) {
              inputSchema.properties![k] = schemaToJsonSchema(v as OpenApiSchema, doc);
              paramMapping.body[k] = k;
            }
            for (const r of derefSchema.required ?? []) {
              if (!inputSchema.required!.includes(r)) inputSchema.required!.push(r);
            }
            bodySchema = derefSchema;
          } else {
            // 非 object body：整体作为单个参数
            inputSchema.properties!['_body'] = { type: 'string', description: 'Request body (raw)' };
            paramMapping.body = { _body: '' };
          }
        }
      }

      const url = baseUrl + path;
      const name = toToolName(op.operationId || op.summary, `${method}_${path}`);
      const description =
        op.summary || op.description || `${method.toUpperCase()} ${path}`;

      const httpBinding: HttpBinding = {
        method: method.toUpperCase() as HttpBinding['method'],
        url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(Object.keys(paramMapping).length ? { paramMapping } : {}),
        ...(bodySchema ? { bodyTemplate: {} } : {}),
        responseMapping: { extract: '' }, // 留空 = 返回整体
        timeoutMs: 15000,
      };

      tools.push({ name, description, inputSchema, httpBinding });
    }
  }

  if (tools.length === 0) {
    return { tools: [], error: 'No importable operations found in document' };
  }
  return { tools };
}
