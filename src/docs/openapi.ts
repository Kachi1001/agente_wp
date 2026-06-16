import crypto from 'crypto';
import { apiModules, extraRoutes } from './apiRegistry';
import { routeMetadata, socketEvents, RouteMeta } from './apiMetadata';
import { config } from '../config';

/**
 * Gerador de documentação inteligente (OpenAPI 3.0).
 *
 * Introspecta os routers do Express em runtime (`router.stack`) e monta a
 * especificação automaticamente. Não há lista de rotas duplicada: a fonte da
 * verdade são os próprios arquivos de `routes/`. Adicionar/remover uma rota
 * muda a spec — e o hash de versão — sem qualquer edição manual.
 */

interface RouteInfo {
  method: string; // minúsculo: get, post, ...
  fullPath: string; // formato Express, ex: /session/start/:id
}

let cachedSpec: Record<string, unknown> | null = null;
let cachedGeneratedAt: string | null = null;

function pkgVersion(): string {
  try {
    // dist/docs/openapi.js → ../../package.json (raiz do projeto)
    // src/docs/openapi.ts  → ../../package.json (mesma raiz em dev)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function joinPath(prefix: string, routePath: string): string {
  if (!routePath || routePath === '/') return prefix;
  return `${prefix}${routePath}`;
}

/** :param → {param} para o formato OpenAPI. */
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function extractPathParams(p: string): string[] {
  const matches = p.match(/:([A-Za-z0-9_]+)/g) || [];
  return matches.map((m) => m.slice(1));
}

/** Lê o `stack` de cada router e coleta { método, caminho completo }. */
function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];

  for (const mod of apiModules) {
    const stack: any[] = (mod.router as any)?.stack || [];
    for (const layer of stack) {
      const route = layer?.route;
      if (!route) continue;

      // route.path pode ser string ou array (rotas com múltiplos caminhos)
      const paths: string[] = Array.isArray(route.path) ? route.path : [route.path];
      // route.methods: { get: true, post: true, _all?: true }
      const methods = Object.keys(route.methods || {}).filter((m) => m !== '_all');

      for (const rawPath of paths) {
        const fullPath = joinPath(mod.prefix, rawPath);
        for (const method of methods) {
          routes.push({ method: method.toLowerCase(), fullPath });
        }
      }
    }
  }

  for (const r of extraRoutes) {
    routes.push({ method: r.method.toLowerCase(), fullPath: r.path });
  }

  return routes;
}

/** "Assinatura" estável da API (ignora descrições/ordem). Muda só com rotas/eventos. */
function shapeStrings(routes: RouteInfo[]): string[] {
  const rest = routes.map((r) => `${r.method.toUpperCase()} ${r.fullPath}`);
  const sockets = [...socketEvents.inbound, ...socketEvents.outbound].map((e) => `SOCKET ${e.name}`);
  return [...rest, ...sockets].sort();
}

/** Hash curto e determinístico do formato da API. */
function computeHash(routes: RouteInfo[]): string {
  const payload = JSON.stringify(shapeStrings(routes));
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function tagForFullPath(fullPath: string): string {
  for (const mod of apiModules) {
    if (fullPath === mod.prefix || fullPath.startsWith(`${mod.prefix}/`)) return mod.tag;
  }
  const extra = extraRoutes.find((r) => r.path === fullPath);
  return extra ? extra.tag : 'Outros';
}

function buildOperation(route: RouteInfo): Record<string, unknown> {
  const key = `${route.method.toUpperCase()} ${route.fullPath}`;
  const meta: RouteMeta | undefined = routeMetadata[key];
  const extra = extraRoutes.find((r) => r.path === route.fullPath && r.method === route.method);

  const op: Record<string, unknown> = {
    tags: [tagForFullPath(route.fullPath)],
    summary: meta?.summary || extra?.summary || `${route.method.toUpperCase()} ${route.fullPath}`,
    responses: { '200': { description: 'Sucesso' } },
  };

  if (meta?.description) op.description = meta.description;

  // Parâmetros de caminho (sempre derivados do path; descrições vêm do metadata).
  const parameters: Record<string, unknown>[] = extractPathParams(route.fullPath).map((name) => ({
    name,
    in: 'path',
    required: true,
    description: meta?.params?.[name],
    schema: { type: 'string' },
  }));

  // Parâmetros de query (apenas do metadata).
  if (meta?.query) {
    for (const q of meta.query) {
      parameters.push({
        name: q.name,
        in: 'query',
        required: !!q.required,
        description: q.description,
        schema: { type: 'string' },
      });
    }
  }

  if (parameters.length) op.parameters = parameters;

  // Corpo da requisição (apenas do metadata).
  if (meta?.body) {
    const contentType = meta.bodyContentType || 'application/json';
    op.requestBody = {
      required: true,
      content: { [contentType]: { schema: meta.body } },
    };
  }

  return op;
}

/** Monta o documento OpenAPI 3.0 completo (com cache, pois rotas não mudam em runtime). */
export function buildOpenApiSpec(): Record<string, unknown> {
  if (cachedSpec) return cachedSpec;

  const routes = collectRoutes();
  const hash = computeHash(routes);
  cachedGeneratedAt = cachedGeneratedAt || new Date().toISOString();

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const oaPath = toOpenApiPath(route.fullPath);
    if (!paths[oaPath]) paths[oaPath] = {};
    paths[oaPath][route.method] = buildOperation(route);
  }

  const tags = [
    ...apiModules.map((m) => ({ name: m.tag, description: m.description })),
    { name: 'Sistema', description: 'Endpoints utilitários.' },
  ];

  cachedSpec = {
    openapi: '3.0.3',
    info: {
      title: 'Agente WP — API',
      version: pkgVersion(),
      description:
        'Documentação gerada automaticamente a partir das rotas vivas do servidor. ' +
        'Use `/api/docs/version` para detectar mudanças (campo `hash`).',
    },
    servers: [{ url: config.baseUrl }],
    tags,
    paths,
    // Extensões: eventos Socket.IO e hash de versão.
    'x-socketio': socketEvents,
    'x-api-hash': hash,
    'x-generated-at': cachedGeneratedAt,
  };

  return cachedSpec;
}

/** Resumo leve para polling de mudanças pelo projeto consumidor. */
export function getApiVersion(): {
  name: string;
  version: string;
  hash: string;
  generatedAt: string;
} {
  const routes = collectRoutes();
  cachedGeneratedAt = cachedGeneratedAt || new Date().toISOString();
  return {
    name: 'agente_wp',
    version: pkgVersion(),
    hash: computeHash(routes),
    generatedAt: cachedGeneratedAt,
  };
}
