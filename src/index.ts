import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import docsRoutes from './routes/docsRoutes';
import { apiModules } from './docs/apiRegistry';
import { getApiVersion } from './docs/openapi';
import { authMiddleware } from './middleware/auth';
import { sessionManager } from './services/SessionManager';
import { socketService } from './services/SocketService';
import { logger } from './utils/logger';

// Initialize environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT || 3005;

// Feature flag: auth só entra em ação quando AUTH_ENABLED=true
// Sem essa variável no servidor, todos os requests passam sem verificação
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const conditionalAuth = AUTH_ENABLED
  ? authMiddleware
  : (_req: Request, _res: Response, next: NextFunction) => next();

if (AUTH_ENABLED) {
  logger.info('[Auth] Autenticação ATIVADA — todas as rotas exigem token.');
} else {
  logger.info('[Auth] Autenticação DESATIVADA (AUTH_ENABLED não definido).');
}

// Global Middleware
app.use(cors());
app.use(express.json());

// Rotas montadas a partir do registro (fonte única de verdade — src/docs/apiRegistry.ts).
// 'conditional' respeita AUTH_ENABLED; 'own' tem autorização própria (ex: /api/logs).
for (const mod of apiModules) {
  if (mod.auth === 'own') {
    app.use(mod.prefix, mod.router);
  } else {
    app.use(mod.prefix, conditionalAuth, mod.router);
  }
}

// Documentação inteligente (auto-gerada das rotas vivas). Leitura pública para
// que o projeto consumidor faça polling sem token: /api/docs, /openapi.json, /version.
app.use('/api/docs', docsRoutes);

// Serve media files
app.use('/media', express.static(path.join(process.cwd(), 'public', 'media')));

// Serve profile pics — fallback para avatar padrão quando a foto não existe
app.use('/profile_pics', express.static(path.join(process.cwd(), 'public', 'profile_pics')));
app.use('/profile_pics', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'public', 'default_avatar.svg'));
});

// Basic Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'agente_wp' });
});

// Initialize Socket.IO via service
socketService.init(httpServer);

httpServer.listen(PORT, async () => {
  logger.info(`WhatsApp Agent Service (with Socket.IO) is running on port ${PORT}`);
  logger.info(`[Docs] Documentação disponível em http://localhost:${PORT}/api/docs (OpenAPI: /api/docs/openapi.json)`);

  // Push para clientes Socket.IO: avisa o hash atual de capacidades da API.
  // Quem reconectar após um deploy recebe o novo hash e pode rebuscar a spec.
  const apiVersion = getApiVersion();
  socketService.emit('capabilities.updated', apiVersion);
  logger.info(`[Docs] Capabilities hash: ${apiVersion.hash}`);

  // Resume previous connections
  await sessionManager.loadSavedSessions();
});

