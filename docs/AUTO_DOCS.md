# Documentação inteligente e auto-atualizável

A API do **Agente WP** publica sua própria documentação, gerada **em runtime a
partir das rotas reais do servidor**. Quando uma feature (rota) é adicionada ou
removida, a documentação muda sozinha — você **não precisa avisar** nenhum outro
projeto manualmente.

## Endpoints

| Endpoint | Para quê |
| --- | --- |
| `GET /api/docs` | Swagger UI navegável (humanos). |
| `GET /api/docs/openapi.json` | Especificação **OpenAPI 3.0** (consumo máquina-a-máquina, geração de client). |
| `GET /api/docs/version` | Resumo leve `{ name, version, hash, generatedAt }` para detectar mudanças. |

> Leitura **pública** (sem token), para o projeto consumidor poder consultar
> livremente. As rotas de negócio continuam respeitando `AUTH_ENABLED`.

## Como detectar mudanças (modelo *pull*)

O `hash` em `/api/docs/version` é uma assinatura determinística do "formato" da
API (métodos + caminhos + eventos Socket.IO). Ele só muda quando a API muda.

```js
// No projeto consumidor — roda periodicamente (ex: a cada 5 min) ou no boot.
let knownHash = null;

async function syncApiDocs() {
  const headers = knownHash ? { 'If-None-Match': `"${knownHash}"` } : {};
  const res = await fetch('http://AGENTE_WP_HOST:3005/api/docs/version', { headers });

  if (res.status === 304) return;            // nada mudou (ETag bate) → sai barato
  const { hash } = await res.json();
  if (hash === knownHash) return;            // sem mudança

  // Mudou! Rebusca a spec completa e atualiza o que depender dela.
  const spec = await fetch('http://AGENTE_WP_HOST:3005/api/docs/openapi.json')
    .then(r => r.json());
  knownHash = hash;
  console.log('API do Agente WP atualizada:', Object.keys(spec.paths).length, 'rotas');
  // ... regenerar client, validar contratos, atualizar UI, etc.
}
```

## Como detectar mudanças (modelo *push* via Socket.IO)

Quem já está conectado por Socket.IO recebe o evento abaixo **ao conectar** e
**no boot do servidor** (após um deploy):

```js
socket.on('capabilities.updated', ({ hash, version, generatedAt }) => {
  if (hash !== knownHash) syncApiDocs(); // rebusca a spec
});
```

## Gerar um client automaticamente (opcional)

Como a spec é OpenAPI 3.0 padrão, qualquer ferramenta consome:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i http://AGENTE_WP_HOST:3005/api/docs/openapi.json \
  -g typescript-axios -o ./src/agente-wp-client
```

## Como funciona por dentro

- `src/docs/apiRegistry.ts` — lista de módulos montados (fonte única; o
  `index.ts` monta a partir dela e o gerador a introspecta).
- `src/docs/openapi.ts` — lê `router.stack` de cada módulo em runtime, monta o
  OpenAPI 3.0 e calcula o `hash`.
- `src/docs/apiMetadata.ts` — descrições/schemas **opcionais**. Uma rota sem
  metadados aqui **ainda aparece** na doc (método + caminho). É melhoria
  progressiva, nunca um requisito.
- `src/routes/docsRoutes.ts` — serve a UI, o `openapi.json` e o `version`.

**Para documentar uma nova rota:** basta criar a rota no arquivo de `routes/`
normalmente. Ela aparece automaticamente. Para enriquecer (descrição, body),
adicione uma entrada opcional em `apiMetadata.ts`.
