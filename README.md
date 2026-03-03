# agente_wp 🤖📱

Microserviço Node.js + TypeScript que atua como **gateway de WhatsApp** para suas aplicações Next.js. Conecta múltiplos números de WhatsApp simultaneamente e roteia mensagens bidirecional via API REST e Webhooks HTTP.

> Para instruções completas de integração, leia o **[AGENTE_WP.md](./AGENTE_WP.md)**.

---

## Funcionalidades

- ✅ Múltiplas sessões de WhatsApp simultâneas (Multi-Device, sem Puppeteer)
- ✅ Roteamento de webhook por sessão — cada Next.js recebe apenas suas mensagens
- ✅ Suporte a texto, imagens, vídeos, áudios (PTT) e documentos
- ✅ Reconexão automática após reinicialização
- ✅ Retry com backoff exponencial (5 tentativas) quando o Next.js estiver indisponível
- ✅ Persistência de sessão e configuração em disco

---

## Quick Start

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite o .env com seus valores
```

### 3. Iniciar em desenvolvimento
```bash
npm run dev
# Servidor na porta 3005
```

### 4. Registrar um celular (sessão)
```bash
curl -X POST http://localhost:3005/session/start/minha-sessao \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "http://seu-nextjs:3000/api/whatsapp-webhook"}'
```

### 5. Verificar QR Code
```bash
curl http://localhost:3005/session/status/minha-sessao
# {"status":"QR_READY","qrCode":"..."}
```
Use o valor de `qrCode` em um gerador de QR ou escanei via terminal (a própria lib exibe no console).

---

## Scripts

| Script          | Descrição                              |
|-----------------|----------------------------------------|
| `npm run dev`   | Inicia com hot-reload (desenvolvimento)|
| `npm run build` | Compila TypeScript para `./dist`       |
| `npm run start` | Inicia a versão compilada (produção)   |

> ⚠️ **Em produção**, sempre execute `npm run build` antes de `npm run start`. O `npm start` executa o JavaScript compilado da pasta `dist/`. Se essa pasta não existir, o servidor vai travar com `MODULE_NOT_FOUND`.

---

## Endpoints

| Método   | Rota                      | Descrição                          |
|----------|---------------------------|------------------------------------|
| `POST`   | `/session/start/:id`      | Inicia sessão e registra webhook   |
| `GET`    | `/session/status/:id`     | Retorna status e QR Code           |
| `DELETE` | `/session/stop/:id`       | Desconecta e apaga dados da sessão |
| `POST`   | `/message/send`           | Envia mensagem ou mídia            |
| `GET`    | `/health`                 | Healthcheck do serviço             |

---

## Estrutura do Projeto

```
src/
├── index.ts              # Servidor Express
├── config.ts             # Variáveis de ambiente
├── controllers/
│   ├── SessionController.ts
│   └── MessageController.ts
├── routes/
│   ├── sessionRoutes.ts
│   └── messageRoutes.ts
└── services/
    ├── SessionManager.ts   # Core: gerencia instâncias Baileys
    └── WebhookService.ts   # Dispara webhooks com retry
```

---

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 5
- **Linguagem:** TypeScript
- **WhatsApp:** [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) (Multi-Device, sem Puppeteer)
- **Retry:** axios-retry com exponential backoff

---

## Segurança

- A pasta `auth_keys/` contém dados sensíveis de sessão e está no `.gitignore`. **Nunca faça commit dessa pasta.**
- Configure `WEBHOOK_SECRET` no `.env` e valide o header `Authorization: Bearer <secret>` no seu Next.js.
