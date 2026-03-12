import { Request, Response } from 'express';
import { sessionManager } from '../services/SessionManager';
import QRCode from 'qrcode';

export const sessionController = {
  async start(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    // Start connection process in background
    sessionManager.startSession(id).catch(console.error);

    res.status(202).json({
      message: `Initializing session ${id}... Poll the /status endpoint to get the QR code.`
    });
  },

  status(req: Request, res: Response): void {
    const id = req.params.id as string;
    const status = sessionManager.getSessionStatus(id);

    if (!status.exists) {
      res.status(404).json({ error: 'Session not found or not initialized' });
      return;
    }

    res.status(200).json(status);
  },

  async qrCode(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    const status = sessionManager.getSessionStatus(id);

    if (!status.exists) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!status.qrCode) {
      res.status(404).json({ error: 'QR Code not available or session already connected' });
      return;
    }

    try {
      const qrImage = await QRCode.toDataURL(status.qrCode);
      res.status(200).json({ qrCode: qrImage });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to generate QR Code image' });
    }
  },

  stop(req: Request, res: Response): void {
    const id = req.params.id as string;
    const status = sessionManager.getSessionStatus(id);

    if (!status.exists) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    sessionManager.deleteSession(id);
    res.status(200).json({ message: `Session ${id} terminated and auth data deleted.` });
  }
};
