import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import sessionRoutes from './routes/sessionRoutes';
import messageRoutes from './routes/messageRoutes';
import contactRoutes from './routes/contactRoutes';
import groupRoutes from './routes/groupRoutes';
import logRoutes from './routes/logRoutes';
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

// Rotas (protegidas ou abertas conforme AUTH_ENABLED)
app.use('/session', conditionalAuth, sessionRoutes);
app.use('/message', conditionalAuth, messageRoutes);
app.use('/contact', conditionalAuth, contactRoutes);
app.use('/group',   conditionalAuth, groupRoutes);

// Logs para a Central — autorização própria (admin-only), sempre ativa.
app.use('/api/logs', logRoutes);

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
  // Resume previous connections
  await sessionManager.loadSavedSessions();
});

