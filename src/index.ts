import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pino from 'pino';
import sessionRoutes from './routes/sessionRoutes';
import messageRoutes from './routes/messageRoutes';
import { sessionManager } from './services/SessionManager';

// Initialize environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;

// Global Middleware
app.use(cors());
app.use(express.json());

// Main Logger
export const logger = pino({
  transport: {
    target: 'pino-pretty', // You might need to install 'pino-pretty' as a dev dependency if you want nicely formatted logs
    options: {
      colorize: true
    }
  }
});

// App Routes
app.use('/session', sessionRoutes);
app.use('/message', messageRoutes);

// Basic Healthcheck
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', service: 'agente_wp' });
});

app.listen(PORT, async () => {
  logger.info(`WhatsApp Agent Service is running on port ${PORT}`);

  // Resume previous connections on startup
  await sessionManager.loadSavedSessions();
});
