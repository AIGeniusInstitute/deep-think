import { describe, it, expect } from 'vitest';
import { parseOpenApi } from '../../src/mcp-registry/openapi-parser.js';

const SAMPLE = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/v1/current': {
      get: {
        operationId: 'getCurrentWeather',
        summary: '获取当前天气',
        parameters: [
          { name: 'city', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'unit', in: 'query', required: false, schema: { type: 'string', enum: ['celsius', 'fahrenheit'], default: 'celsius' } },
        ],
      },
    },
    '/v1/forecast/{days}': {
      get: {
        operationId: 'getForecast',
        parameters: [
          { name: 'days', in: 'path', required: true, schema: { type: 'integer' } },
        ],
      },
      post: {
        operationId: 'createForecast',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { label: { type: 'string' } },
                required: ['label'],
              },
            },
          },
        },
      },
    },
  },
};

describe('parseOpenApi', () => {
  it('produces candidate tools from paths+methods', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE));
    expect(tools.length).toBe(3);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['createForecast', 'getCurrentWeather', 'getForecast'].sort());
  });

  it('builds inputSchema with required + enum (T3)', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE));
    const cur = tools.find((t) => t.name === 'getCurrentWeather')!;
    expect(cur.inputSchema.required).toContain('city');
    expect((cur.inputSchema.properties!['unit'] as any).enum).toEqual(['celsius', 'fahrenheit']);
    expect(cur.httpBinding.url).toBe('https://api.example.com/v1/current');
  });

  it('maps path + query paramMapping (T3)', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE));
    const fc = tools.find((t) => t.name === 'getForecast')!;
    expect(fc.httpBinding.paramMapping?.path).toEqual({ days: 'days' });
    expect(fc.httpBinding.url).toBe('https://api.example.com/v1/forecast/{days}');
  });

  it('flattens requestBody object into body mapping (T3)', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE));
    const cf = tools.find((t) => t.name === 'createForecast')!;
    expect(cf.httpBinding.method).toBe('POST');
    expect(cf.httpBinding.paramMapping?.body).toEqual({ label: 'label' });
    expect(cf.inputSchema.required).toContain('label');
  });

  it('includePaths filters (AC3.4)', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE), { includePaths: ['/v1/current'] });
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('getCurrentWeather');
  });

  it('rejects non-OpenAPI doc (AC3.3)', () => {
    expect(parseOpenApi('{ "foo": 1 }').error).toBeTruthy();
    expect(parseOpenApi('not json').error).toBeTruthy();
  });

  it('baseUrl override beats servers[0] (T3)', () => {
    const { tools } = parseOpenApi(JSON.stringify(SAMPLE), { baseUrl: 'https://other.example.com' });
    expect(tools[0].httpBinding.url).toContain('https://other.example.com');
  });
});
