import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 3005,
  webhookUrl: process.env.WEBHOOK_URL || 'http://localhost:3000/api/whatsapp-webhook',
  webhookSecret: process.env.WEBHOOK_SECRET || 'secret-key' // Opcional, para segurança
};
