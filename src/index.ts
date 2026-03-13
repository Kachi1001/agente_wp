import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { createServer } from 'http';
import sessionRoutes from './routes/sessionRoutes';
import messageRoutes from './routes/messageRoutes';
import contactRoutes from './routes/contactRoutes';
import { sessionManager } from './services/SessionManager';
import { socketService } from './services/SocketService';
import { logger } from './utils/logger';

// Initialize environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);

const PORT = process.env.PORT || 3005;

// Global Middleware
app.use(cors());
app.use(express.json());

// App Routes
app.use('/session', sessionRoutes);
app.use('/message', messageRoutes);
app.use('/contact', contactRoutes);

// Serve media files
app.use('/media', express.static(path.join(process.cwd(), 'public', 'media')));

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

