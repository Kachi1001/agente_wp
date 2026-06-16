import { Router, Request, Response } from 'express';
import { buildOpenApiSpec, getApiVersion } from '../docs/openapi';

/**
 * Documentação inteligente e auto-atualizável.
 *
 *  GET /api/docs            → Swagger UI (navegável por humanos)
 *  GET /api/docs/openapi.json → especificação OpenAPI 3.0 (consumo máquina-a-máquina)
 *  GET /api/docs/version    → { hash, version, generatedAt } p/ detectar mudanças (polling)
 *
 * O projeto consumidor faz polling em /version: se o `hash` mudou, busca de novo
 * o openapi.json. Nada precisa ser informado manualmente quando uma feature
 * é adicionada ou removida.
 */
const router = Router();

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agente WP — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body { margin: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: 'openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    };
  </script>
</body>
</html>`;

// Especificação OpenAPI 3.0 (auto-gerada).
router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(buildOpenApiSpec());
});

// Resumo de versão p/ polling. Usa ETag = hash para respostas 304 baratas.
router.get('/version', (req: Request, res: Response) => {
  const version = getApiVersion();
  const etag = `"${version.hash}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.json(version);
});

// Swagger UI (HTML). Atende /api/docs e /api/docs/.
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(SWAGGER_UI_HTML);
});

export default router;
