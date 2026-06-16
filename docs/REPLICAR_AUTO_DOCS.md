# Como replicar a "documentação automática" em outro projeto

Guia portável para reproduzir o sistema de documentação auto-atualizável
(OpenAPI/Swagger gerado das rotas vivas) em **qualquer projeto Express**.

---

## 1. A ideia central (por que ela se atualiza sozinha)

O segredo é **não manter uma lista de rotas escrita à mão**. Em vez disso, o
servidor **se olha por dentro** (introspecção) e descobre quais rotas existem,
em tempo de execução.

```
rotas reais do Express  ──introspecção──▶  spec OpenAPI  ──▶  /api/docs (endpoint)
        ▲                                        │
   (fonte da verdade)                            └── hash de versão muda quando rotas mudam
```

Como a documentação é **derivada** das rotas (e não escrita em paralelo a elas),
ela nunca fica desatualizada. Adicionou/removeu uma rota → a doc e o `hash`
mudam sozinhos. Nenhum outro projeto precisa ser avisado: ele só consulta o
endpoint e compara o `hash`.

---

## 2. As 4 peças

| Peça | Papel |
| --- | --- |
| **Registro de módulos** | Lista `{ prefixo, router }`. Fonte única: o app monta a partir dela **e** o gerador a introspecta. |
| **Gerador OpenAPI** | Lê `router.stack` de cada módulo, monta o JSON OpenAPI 3.0 e calcula um `hash` do "formato" da API. |
| **Metadados (opcional)** | Descrições/schemas por rota. Rota sem metadado **ainda aparece** (método + caminho). Melhoria progressiva. |
| **Rotas de docs** | Servem Swagger UI, `openapi.json` e `version` (para polling). |

O truque técnico que torna isso robusto: cada `Router` do Express guarda suas
rotas em `router.stack`, e cada rota expõe `route.path` (ex: `/start/:id`) e
`route.methods` (ex: `{ post: true }`) **já em texto limpo** — sem precisar
fazer parsing de regex. Você só junta o prefixo do módulo na frente.

---

## 3. Passo a passo

### Passo 1 — Registro de módulos (`docs/apiRegistry.ts`)

Centralize onde cada router é montado:

```ts
import { Router } from 'express';
import userRoutes from '../routes/userRoutes';
import orderRoutes from '../routes/orderRoutes';

export interface ApiModule { prefix: string; router: Router; tag: string; }

export const apiModules: ApiModule[] = [
  { prefix: '/users',  router: userRoutes,  tag: 'Usuários' },
  { prefix: '/orders', router: orderRoutes, tag: 'Pedidos'  },
];
```

No `index.ts`, monte a partir dessa lista (assim ela é a única fonte da verdade):

```ts
import { apiModules } from './docs/apiRegistry';
for (const mod of apiModules) app.use(mod.prefix, mod.router);
```

### Passo 2 — Gerador OpenAPI (`docs/openapi.ts`)

```ts
import crypto from 'crypto';
import { apiModules } from './apiRegistry';

interface RouteInfo { method: string; fullPath: string; }

function collectRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of apiModules) {
    const stack: any[] = (mod.router as any)?.stack || [];
    for (const layer of stack) {
      if (!layer.route) continue;                       // só camadas de rota
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods || {}).filter(m => m !== '_all');
      for (const p of paths) {
        const fullPath = (!p || p === '/') ? mod.prefix : mod.prefix + p;
        for (const m of methods) routes.push({ method: m.toLowerCase(), fullPath });
      }
    }
  }
  return routes;
}

const toOpenApi = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const pathParams = (p: string) => (p.match(/:([A-Za-z0-9_]+)/g) || []).map(s => s.slice(1));

function hashOf(routes: RouteInfo[]): string {
  const shape = routes.map(r => `${r.method.toUpperCase()} ${r.fullPath}`).sort();
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}

let cached: any = null;
export function buildOpenApiSpec() {
  if (cached) return cached;
  const routes = collectRoutes();
  const paths: any = {};
  for (const r of routes) {
    const oa = toOpenApi(r.fullPath);
    (paths[oa] ||= {})[r.method] = {
      tags: [apiModules.find(m => r.fullPath.startsWith(m.prefix))?.tag || 'Outros'],
      summary: `${r.method.toUpperCase()} ${r.fullPath}`,
      parameters: pathParams(r.fullPath).map(name => ({
        name, in: 'path', required: true, schema: { type: 'string' },
      })),
      responses: { '200': { description: 'Sucesso' } },
    };
  }
  cached = {
    openapi: '3.0.3',
    info: { title: 'Minha API', version: '1.0.0' },
    paths,
    'x-api-hash': hashOf(routes),
  };
  return cached;
}

export function getApiVersion() {
  return { hash: hashOf(collectRoutes()), generatedAt: new Date().toISOString() };
}
```

### Passo 3 — Rotas de docs (`routes/docsRoutes.ts`)

```ts
import { Router } from 'express';
import { buildOpenApiSpec, getApiVersion } from '../docs/openapi';

const router = Router();

router.get('/openapi.json', (_req, res) => res.json(buildOpenApiSpec()));

router.get('/version', (req, res) => {
  const v = getApiVersion();
  const etag = `"${v.hash}"`;
  res.setHeader('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.json(v);
});

router.get('/', (_req, res) => res.type('html').send(`<!DOCTYPE html><html><head>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/></head>
  <body><div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: 'openapi.json', dom_id: '#swagger-ui' });</script>
  </body></html>`));

export default router;
```

E no `index.ts`:

```ts
import docsRoutes from './routes/docsRoutes';
app.use('/api/docs', docsRoutes);   // leitura pública
```

### Passo 4 (opcional) — Metadados ricos

Crie um mapa `{ 'POST /users': { summary, body, ... } }` e faça o gerador
mesclá-lo em `buildOperation`. Rotas sem entrada continuam aparecendo sozinhas.
(No `agente_wp`, veja `src/docs/apiMetadata.ts` como referência completa.)

---

## 4. Como o outro projeto consome (sem você avisar nada)

```js
let knownHash = null;
async function sync() {
  const r = await fetch('http://HOST/api/docs/version',
    { headers: knownHash ? { 'If-None-Match': `"${knownHash}"` } : {} });
  if (r.status === 304) return;            // nada mudou
  const { hash } = await r.json();
  if (hash === knownHash) return;
  knownHash = hash;
  const spec = await fetch('http://HOST/api/docs/openapi.json').then(r => r.json());
  // ...regenerar client / atualizar contrato
}
setInterval(sync, 5 * 60 * 1000);          // polling a cada 5 min
```

---

## 5. Checklist de replicação

- [ ] Criar `apiRegistry.ts` e montar as rotas a partir dele no `index.ts`.
- [ ] Copiar `openapi.ts` (ajustar `info.title`/`version`).
- [ ] Copiar `docsRoutes.ts` e montar em `/api/docs`.
- [ ] Subir e abrir `/api/docs`. Conferir se todas as rotas aparecem.
- [ ] (Opcional) Adicionar `apiMetadata.ts` para descrições/schemas.
- [ ] (Opcional) Emitir `capabilities.updated` por WebSocket no boot/conexão.

---

## 6. Adaptando para outras stacks

A **ideia** é a mesma (derivar a doc das rotas reais), mas a introspecção muda:

| Stack | Como gerar OpenAPI automaticamente |
| --- | --- |
| **Express** (este guia) | Ler `router.stack` em runtime. |
| **NestJS** | `@nestjs/swagger` (`SwaggerModule`) — lê os decorators. |
| **Fastify** | `@fastify/swagger` — usa os JSON Schemas das rotas. |
| **FastAPI (Python)** | Nativo: `/openapi.json` e `/docs` já vêm prontos. |
| **Spring Boot (Java)** | `springdoc-openapi`. |

Em todos, o consumo (passo 4) é idêntico: outro projeto faz polling no `hash`
ou no `openapi.json` e se atualiza sozinho.
```
