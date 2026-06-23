#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';

// ──────────────────────────────────────────────────────────────────────────────
// Servidor MCP de DOCUMENTAÇÃO do agente_wp (standalone .mjs, espelha o central-api).
//
// Expõe as rotas vivas desta API como ferramentas para o Claude descobrir e
// consultar o contrato sem curl/Swagger.
//
// Fonte da verdade — o próprio servidor agente_wp em runtime:
//   GET {BASE_URL}/api/docs/openapi.json   → spec OpenAPI 3.0 completa
//   GET {BASE_URL}/api/docs/version        → { hash, version, generatedAt }
//
// BASE_URL vem de AGENTE_WP_BASE_URL (default http://localhost:3005).
// Roda com `node` + caminho absoluto; resolve @modelcontextprotocol/sdk, zod e
// axios a partir do node_modules do próprio agente_wp (resolução p/ cima).
// ──────────────────────────────────────────────────────────────────────────────

const BASE_URL = (process.env.AGENTE_WP_BASE_URL || 'http://localhost:3005').replace(/\/$/, '');

let specCache = null;
const SPEC_TTL_MS = 15_000;

async function fetchSpec(force = false) {
  if (!force && specCache && Date.now() - specCache.fetchedAt < SPEC_TTL_MS) {
    return specCache.spec;
  }
  try {
    const { data } = await axios.get(`${BASE_URL}/api/docs/openapi.json`, { timeout: 8000 });
    specCache = { spec: data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    const detail = err?.response?.status ? `HTTP ${err.response.status}` : err?.code || err?.message || String(err);
    throw new Error(
      `Não foi possível obter a documentação em ${BASE_URL}/api/docs/openapi.json (${detail}). ` +
      `Verifique se o agente_wp está rodando ou ajuste AGENTE_WP_BASE_URL.`,
    );
  }
}

function flattenRoutes(spec) {
  const out = [];
  const paths = spec?.paths || {};
  for (const path of Object.keys(paths)) {
    const methods = paths[path];
    for (const method of Object.keys(methods)) {
      const op = methods[method];
      out.push({
        method: method.toUpperCase(),
        path,
        tag: (op?.tags && op.tags[0]) || 'Sem tag',
        summary: op?.summary || '',
        operation: op,
      });
    }
  }
  return out;
}

function jsonContent(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: 'agente-wp-docs', version: '1.0.0' });

server.tool(
  'list_routes',
  'Lista todas as rotas da API do agente_wp (método + caminho + tag + summary). Filtros opcionais por tag e/ou prefixo de caminho.',
  {
    prefix: z.string().optional().describe('Filtra por prefixo de caminho, ex: "/message".'),
    tag: z.string().optional().describe('Filtra por tag exata, ex: "Mensagens".'),
  },
  async ({ prefix, tag }) => {
    const spec = await fetchSpec();
    let routes = flattenRoutes(spec).map(({ operation, ...r }) => r);
    if (prefix) routes = routes.filter((r) => r.path.startsWith(prefix));
    if (tag) routes = routes.filter((r) => r.tag === tag);
    routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
    return jsonContent({ baseUrl: BASE_URL, count: routes.length, routes });
  },
);

server.tool(
  'search_routes',
  'Busca rotas por palavra-chave no método, caminho, tag, summary ou descrição. Útil para achar o endpoint certo, ex: "localização", "enviar", "grupo".',
  { query: z.string().describe('Termo de busca.') },
  async ({ query }) => {
    const spec = await fetchSpec();
    const q = query.toLowerCase();
    const routes = flattenRoutes(spec)
      .filter((r) => {
        const desc = (r.operation?.description || '').toLowerCase();
        return (
          r.method.toLowerCase().includes(q) ||
          r.path.toLowerCase().includes(q) ||
          r.tag.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          desc.includes(q)
        );
      })
      .map(({ operation, ...r }) => r);
    return jsonContent({ baseUrl: BASE_URL, query, count: routes.length, routes });
  },
);

server.tool(
  'get_route',
  'Retorna o detalhe completo de UMA rota (parâmetros, corpo da requisição e respostas). Use após achar a rota com list_routes/search_routes.',
  {
    method: z.string().describe('Método HTTP, ex: "POST".'),
    path: z.string().describe('Caminho exato da rota, ex: "/message/send-location".'),
  },
  async ({ method, path }) => {
    const spec = await fetchSpec();
    const m = method.toLowerCase();
    const operation = spec?.paths?.[path]?.[m];
    if (!operation) {
      const available = flattenRoutes(spec).filter((r) => r.path === path).map((r) => r.method);
      const hint = available.length
        ? `Métodos disponíveis para ${path}: ${available.join(', ')}.`
        : `Caminho ${path} não encontrado. Use list_routes para ver os caminhos válidos.`;
      throw new Error(`Rota ${method.toUpperCase()} ${path} não encontrada. ${hint}`);
    }
    return jsonContent({ method: method.toUpperCase(), path, operation });
  },
);

server.tool(
  'get_spec',
  'Retorna o documento OpenAPI 3.0 completo do agente_wp (JSON). Use quando precisar do contrato inteiro, ex: para gerar um client.',
  {},
  async () => jsonContent(await fetchSpec(true)),
);

server.tool(
  'version',
  'Retorna { hash, version, generatedAt } da documentação. O `hash` muda quando as rotas mudam — útil para detectar atualizações via polling.',
  {},
  async () => {
    try {
      const { data } = await axios.get(`${BASE_URL}/api/docs/version`, { timeout: 8000 });
      return jsonContent(data);
    } catch {
      const spec = await fetchSpec();
      return jsonContent({
        hash: spec['x-api-hash'] ?? null,
        version: spec?.info?.version ?? null,
        generatedAt: spec['x-generated-at'] ?? null,
      });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[agente-wp-docs MCP] pronto. BASE_URL=${BASE_URL}`);
