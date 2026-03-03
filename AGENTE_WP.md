# AGENTE_WP — Manual Completo de Integração

Este documento é a **Bíblia de Integração** do microserviço `agente_wp`. Se você é uma IA ou desenvolvedor integrando um projeto Next.js a este agente, **este é o ponto de partida obrigatório**.

---

## 1. O que é e para que serve

O `agente_wp` é um **microserviço Node.js** que age como uma camada intermediária (gateway) entre o protocolo do WhatsApp e suas aplicações Next.js. Ele resolve o problema de ter que embutir a biblioteca do WhatsApp dentro de cada aplicação.

**Responsabilidades do `agente_wp`:**
- Manter conexões ativas com múltiplos números de WhatsApp simultaneamente.
- Receber mensagens do WhatsApp e repassá-las via HTTP (Webhook) para a aplicação correta.
- Receber comandos de envio da aplicação Next.js e disparar mensagens no WhatsApp.
- Persistir autenticação (Multi-Device) para reconectar automaticamente após reinicialização.

**O que o `agente_wp` NÃO faz:**
- Não tem banco de dados.
- Não tem regras de negócio (bots, filas, tickets).
- Não decide o que fazer com uma mensagem — isso é responsabilidade do Next.js.

---

## 2. Arquitetura e Fluxo de Dados

```
┌──────────────────────────────────────────────────────────────────────┐
│                         AGENTE_WP (porta 3005)                        │
│                                                                        │
│  Sessão "ti-suporte" ◄──► WhatsApp 📱 (celular do TI)                │
│  Sessão "rh-geral"   ◄──► WhatsApp 📱 (celular do RH)                │
│  Sessão "vendas"     ◄──► WhatsApp 📱 (celular de Vendas)            │
└─────────────┬─────────────────┬──────────────────┬────────────────────┘
              │                 │                  │
              ▼                 ▼                  ▼
   ┌──────────────────┐ ┌───────────────┐ ┌────────────────────┐
   │  atendimento_ti  │ │ atendimento_rh│ │   qualquer_app     │
   │  :3000           │ │ :3001         │ │   :3002            │
   │                  │ │               │ │                    │
   │ /api/wp-webhook  │ │/api/wp-webhook│ │ /api/wp-webhook    │
   └──────────────────┘ └───────────────┘ └────────────────────┘
```

### Fluxo de ENTRADA (WhatsApp → Next.js):
1. O celular conectado à sessão `ti-suporte` recebe uma mensagem.
2. O `agente_wp` captura o evento via Baileys.
3. Monta um payload JSON padronizado com os dados da mensagem.
4. Faz um `HTTP POST` para o `webhookUrl` cadastrado para a sessão `ti-suporte`.
5. O Next.js recebe, processa (salva no banco, aciona bot, emite Socket.IO para o painel, etc.).

### Fluxo de SAÍDA (Next.js → WhatsApp):
1. A lógica do Next.js decide enviar uma resposta (bot ou atendente).
2. O Next.js faz um `HTTP POST` para `http://agente_wp:3005/message/send`.
3. O `agente_wp` usa a sessão informada para disparar a mensagem/mídia via WhatsApp.
4. Retorna `200 OK` com confirmação ou erro para o Next.js.

---

## 3. Instalação e Execução do Agente

### Pré-requisitos
- Node.js 18+
- Acesso à internet (o Baileys precisa comunicar com servidores Meta)

### Rodar em Desenvolvimento
```bash
cd agente_wp
npm install
npm run dev
# Servidor inicia na porta 3005 (configurável via PORT no .env)
```

### Variáveis de Ambiente (`.env`)
Crie um arquivo `.env` na raiz do `agente_wp`:
```env
PORT=3005

# Fallback global: usado apenas se uma sessão não tiver webhookUrl individual cadastrado.
# Na maioria dos casos com múltiplos projetos, você NÃO vai usar essa variável.
WEBHOOK_URL=

# Chave de segurança enviada no header Authorization de cada webhook
WEBHOOK_SECRET=minha-chave-secreta-aqui
```

---

## 4. API REST do Agente — Referência Completa

O `agente_wp` roda em `http://localhost:3005` por padrão.

### 4.1 Gerenciamento de Sessões (WhatsApp)

---

#### `POST /session/start/:id`

Inicia uma nova sessão de WhatsApp. Este é **o primeiro endpoint a chamar** ao adicionar um novo número.

**Parâmetros de URL:**
| Parâmetro | Tipo   | Obrigatório | Descrição                                      |
|-----------|--------|-------------|------------------------------------------------|
| `id`      | string | Sim         | Nome único da sessão (ex: `ti-suporte`, `rh-geral`). Pode ser qualquer string sem espaços. |

**Corpo (Body) — JSON:**
| Campo        | Tipo   | Obrigatório | Descrição                                                             |
|--------------|--------|-------------|-----------------------------------------------------------------------|
| `webhookUrl` | string | **Sim**     | URL completa da rota da sua aplicação Next.js que receberá as mensagens desta sessão. |

**Exemplo de Requisição:**
```bash
curl -X POST http://localhost:3005/session/start/ti-suporte \
  -H "Content-Type: application/json" \
  -d '{ "webhookUrl": "http://localhost:3000/api/whatsapp-webhook" }'
```

**Resposta (`202 Accepted`):**
```json
{
  "message": "Initializing session ti-suporte... Poll the /status endpoint to get the QR code.",
  "webhookUrl": "http://localhost:3000/api/whatsapp-webhook"
}
```

> **IMPORTANTE:** Esta rota retorna imediatamente (`202`). A conexão com o WhatsApp acontece em background. Você deve chamar o endpoint de status em loop até o QR Code aparecer.

> **PERSISTÊNCIA:** O `webhookUrl` é salvo automaticamente em disco dentro de `auth_keys/ti-suporte/session_config.json`. Ao reiniciar o `agente_wp`, as sessões reconectam automaticamente sem precisar chamar este endpoint novamente.

---

#### `GET /session/status/:id`

Retorna o estado atual da sessão, incluindo o QR Code quando disponível.

**Exemplo de Requisição:**
```bash
curl http://localhost:3005/session/status/ti-suporte
```

**Resposta quando aguardando QR Code (`200 OK`):**
```json
{
  "exists": true,
  "status": "QR_READY",
  "qrCode": "1@longo_codigo_do_qr_code_em_base64..."
}
```

**Resposta quando já conectado (`200 OK`):**
```json
{
  "exists": true,
  "status": "CONNECTED",
  "qrCode": null
}
```

**Possíveis valores de `status`:**
| Valor          | Significado                                               |
|----------------|-----------------------------------------------------------|
| `STARTING`     | Aguardando inicialização do socket com WhatsApp           |
| `QR_READY`     | QR Code disponível, aguardando leitura pelo celular       |
| `CONNECTED`    | Celular conectado, sessão ativa e recebendo mensagens     |
| `DISCONNECTED` | Desconectado (pode tentar reconectar automaticamente)     |

---

#### `DELETE /session/stop/:id`

Para a sessão, desconecta o celular e apaga todos os dados de autenticação. **Ação irreversível** — o usuário precisará ler o QR Code novamente.

**Exemplo de Requisição:**
```bash
curl -X DELETE http://localhost:3005/session/stop/ti-suporte
```

**Resposta (`200 OK`):**
```json
{
  "message": "Session ti-suporte terminated and auth data deleted."
}
```

---

### 4.2 Envio de Mensagens

---

#### `POST /message/send`

Envia uma mensagem (texto ou mídia) através de uma sessão ativa. **Chamado pelo Next.js** quando quer responder ao usuário.

**Corpo (Body) — JSON:**
| Campo       | Tipo    | Obrigatório           | Descrição                                                              |
|-------------|---------|-----------------------|------------------------------------------------------------------------|
| `sessionId` | string  | Sim                   | ID da sessão a usar (ex: `ti-suporte`)                                 |
| `to`        | string  | Sim                   | Número do destinatário com DDI+DDD (ex: `5511999999999`)               |
| `text`      | string  | Condicional           | Texto da mensagem. Para mídia, funciona como legenda.                  |
| `isGroup`   | boolean | Não (default: `false`)| `true` se o destinatário for um grupo.                                |
| `mediaUrl`  | string  | Não                   | URL pública do arquivo de mídia. O agente baixa e envia.              |
| `mediaType` | string  | Condicional           | Tipo da mídia: `image`, `video`, `audio`, `ptt` ou `document`.        |

> **Pelo menos um de `text` ou `mediaUrl` é obrigatório.**

**Exemplos:**

*Enviar texto simples:*
```bash
curl -X POST http://localhost:3005/message/send \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "ti-suporte",
    "to": "5511999999999",
    "text": "Olá! Seu ticket foi aberto."
  }'
```

*Enviar imagem com legenda:*
```json
{
  "sessionId": "ti-suporte",
  "to": "5511999999999",
  "text": "Segue o print do erro:",
  "mediaUrl": "https://meusite.com/imagem.png",
  "mediaType": "image"
}
```

*Enviar áudio como mensagem de voz (PTT):*
```json
{
  "sessionId": "ti-suporte",
  "to": "5511999999999",
  "mediaUrl": "https://meusite.com/audio.mp3",
  "mediaType": "ptt"
}
```

*Enviar documento (PDF, etc.):*
```json
{
  "sessionId": "ti-suporte",
  "to": "5511999999999",
  "text": "manual.pdf",
  "mediaUrl": "https://meusite.com/manual.pdf",
  "mediaType": "document"
}
```

**Resposta de sucesso (`200 OK`):**
```json
{ "success": true, "message": "Message/Media sent successfully" }
```

**Resposta de erro — sessão não conectada (`400`):**
```json
{ "error": "Session ti-suporte is not connected." }
```

---

### 4.3 Healthcheck

#### `GET /health`
Verifica se o serviço está no ar.

```bash
curl http://localhost:3005/health
# {"status":"OK","service":"agente_wp"}
```

---

## 5. Webhook: O que o Next.js vai receber

Sempre que uma mensagem chegar em qualquer sessão, o `agente_wp` fará um `HTTP POST` para o `webhookUrl` cadastrado da sessão, com o seguinte payload:

### Payload padrão (todas as mensagens)
```json
{
  "eventType": "message.received",
  "session": "ti-suporte",
  "timestamp": "2026-03-03T14:00:00.000Z",
  "data": {
    "id": "BAE5XXXXXXXXXXXX",
    "from": "5511999999999@s.whatsapp.net",
    "text": "Olá, preciso de ajuda!",
    "pushName": "João Silva",
    "mediaType": "text",
    "hasMedia": false,
    "timestamp": 1709476800,
    "raw": { ... }
  }
}
```

### Campos do `data`
| Campo       | Tipo    | Descrição                                                         |
|-------------|---------|-------------------------------------------------------------------|
| `id`        | string  | ID único da mensagem no WhatsApp                                  |
| `from`      | string  | JID do remetente (número + `@s.whatsapp.net` ou `@g.us` para grupos) |
| `text`      | string  | Texto limpo da mensagem (ou legenda da mídia)                     |
| `pushName`  | string  | Nome salvo no WhatsApp do remetente                               |
| `mediaType` | string  | `text`, `image`, `video`, `audio`, `document` ou `sticker`       |
| `hasMedia`  | boolean | `true` se a mensagem contém mídia                                 |
| `timestamp` | number  | Unix timestamp de quando a mensagem foi enviada                   |
| `raw`       | object  | Objeto original completo do Baileys (inclui chaves para download de mídia) |

### Extraindo o número limpo do campo `from`
O campo `from` vem no formato JID do WhatsApp. Para obter só o número:
```typescript
const phoneNumber = data.from.split('@')[0]; // "5511999999999"
```

### Headers enviados pelo agente
O `agente_wp` envia os seguintes headers em cada webhook:
```
Content-Type: application/json
Authorization: Bearer <WEBHOOK_SECRET do .env>
```

Seu Next.js **deve validar** esse header para rejeitar webhooks não autorizados.

---

## 6. Como Implementar o Webhook no Next.js

### Exemplo de rota (`/api/whatsapp-webhook.ts`):
```typescript
import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  // Validação de segurança
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (secret !== process.env.AGENTE_WP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { session, data } = req.body;

  // Número limpo do remetente
  const phoneNumber = data.from.split('@')[0];

  console.log(`[${session}] Nova mensagem de ${data.pushName} (${phoneNumber}): ${data.text}`);

  // Aqui você coloca sua lógica de negócio:
  // - Buscar/criar contato no banco
  // - Criar ou atualizar ticket
  // - Chamar o bot
  // - Emitir evento Socket.IO para o painel
  // - etc.

  // Sempre retorne 200 para o agente saber que recebeu com sucesso
  res.status(200).json({ received: true });
}
```

### Variáveis de ambiente a adicionar no `.env` do Next.js:
```env
# URL base do agente (local ou produção)
AGENTE_WP_URL=http://localhost:3005

# Mesmo segredo configurado no WEBHOOK_SECRET do agente
AGENTE_WP_SECRET=minha-chave-secreta-aqui
```

---

## 7. Como Enviar Mensagens a Partir do Next.js

Crie uma função helper de envio:

```typescript
// src/lib/agente.ts
import axios from 'axios';

const agente = axios.create({
  baseURL: process.env.AGENTE_WP_URL,
  timeout: 10000,
});

const SESSION_ID = 'ti-suporte'; // Mude conforme o ID da sessão desta aplicação

export async function sendWhatsAppMessage(to: string, text: string) {
  return agente.post('/message/send', {
    sessionId: SESSION_ID,
    to,
    text,
  });
}

export async function sendWhatsAppImage(to: string, imageUrl: string, caption = '') {
  return agente.post('/message/send', {
    sessionId: SESSION_ID,
    to,
    text: caption,
    mediaUrl: imageUrl,
    mediaType: 'image',
  });
}

export async function sendWhatsAppAudio(to: string, audioUrl: string) {
  return agente.post('/message/send', {
    sessionId: SESSION_ID,
    to,
    mediaUrl: audioUrl,
    mediaType: 'ptt', // Mensagem de voz
  });
}
```

**Usando nas rotas de API:**
```typescript
// /api/send-message.ts — substitui o whatsapp-web.js local
import { sendWhatsAppMessage } from '../../lib/agente';

export default async function handler(req, res) {
  const { to, text } = req.body;
  await sendWhatsAppMessage(to, text);
  res.status(200).json({ sent: true });
}
```

---

## 8. Guia de Migração: Substituindo o whatsapp-web.js Local

Se o projeto Next.js usa `whatsapp-web.js` embutido, siga este roteiro de migração:

### Passo 1 — Configurar o `agente_wp`
1. Suba o servidor `agente_wp` (rodando `npm run dev` na pasta).
2. Registrar a sessão via `POST /session/start/<id>` com o `webhookUrl` apontando para o Next.js.
3. Escaneie o QR Code que aparecer no terminal do agente com o celular desejado.
4. Valide com `GET /session/status/<id>` que retornou `"CONNECTED"`.

### Passo 2 — Criar a rota de webhook no Next.js
Crie o arquivo `src/pages/api/whatsapp-webhook.ts` conforme o exemplo da seção 6.
Esta rota substitui toda a lógica do `on('message')` do `whatsapp-web.js`.

### Passo 3 — Criar o helper de envio
Crie o `src/lib/agente.ts` conforme o exemplo da seção 7.

### Passo 4 — Remover os listeners antigos
No arquivo que inicializava o `whatsapp-web.js` (ex: `whatsapp.ts` ou `server.ts`):
- Remova o `import { Client } from 'whatsapp-web.js'`.
- Remova o `client.on('message', ...)`.
- Remova toda a lógica de `client.sendMessage(...)`.
- Substitua as chamadas de `client.sendMessage(...)` pelas funções do `agente.ts`.

### Passo 5 — Ajustar variáveis de ambiente
Remova do `.env` do Next.js qualquer variável referente ao `puppeteer`/`whatsapp-web.js` e adicione as variáveis do agente (seção 6).

### Passo 6 — Remover dependência (opcional mas recomendado)
```bash
npm uninstall whatsapp-web.js puppeteer
```

---

## 9. Sistema de Retry (Tolerância a Falhas)

O `agente_wp` tem uma camada de retry automático nos webhooks. Se o Next.js estiver reiniciando ou temporariamente indisponível, o agente tentará reenviar a mensagem automaticamente:

| Tentativa | Espera antes de tentar novamente |
|-----------|----------------------------------|
| 1ª retry  | ~1 segundo                       |
| 2ª retry  | ~2 segundos                      |
| 3ª retry  | ~4 segundos                      |
| 4ª retry  | ~8 segundos                      |
| 5ª retry  | ~16 segundos                     |

Após 5 tentativas, o erro é logado como **FALHA DEFINITIVA** e a mensagem é descartada. O log do terminal mostrará qual sessão e qual URL falhou.

---

## 10. Estrutura de Pastas do Projeto

```
agente_wp/
├── src/
│   ├── index.ts              # Servidor Express principal + inicialização de sessões salvas
│   ├── config.ts             # Carregamento de variáveis de ambiente
│   ├── controllers/
│   │   ├── SessionController.ts  # Lógica HTTP para gerenciar sessões
│   │   └── MessageController.ts  # Lógica HTTP para envio de mensagens
│   ├── routes/
│   │   ├── sessionRoutes.ts      # Mapeamento de rotas /session/*
│   │   └── messageRoutes.ts      # Mapeamento de rotas /message/*
│   └── services/
│       ├── SessionManager.ts     # Coração do agente: gerencia instâncias Baileys
│       └── WebhookService.ts     # Responsável por fazer POST para o Next.js (com retry)
├── auth_keys/                # (Gerado automaticamente) Dados de sessão por pasta
│   └── ti-suporte/
│       ├── creds.json            # Credenciais de autenticação Multi-Device
│       └── session_config.json   # webhookUrl persistido desta sessão
├── AGENTE_WP.md              # Este documento
├── package.json
└── .env
```

---

## 11. Regras de Ouro para a IA Integrando um Projeto

Se você é uma IA integrando um projeto Next.js a este agente, siga estas regras:

1. **Leia este documento inteiro primeiro** antes de modificar qualquer arquivo.
2. **O `agente_wp` é somente-leitura para o Next.js** — o Next.js nunca deve modificar arquivos do `agente_wp`, apenas consumi-lo via HTTP.
3. **Sempre crie o `/api/whatsapp-webhook` primeiro**, só então remova o código legado.
4. **Nunca apague os listeners do antigo whatsapp.js** antes de testar que o webhook novo está funcionando.
5. **O campo `from` vem no formato JID** — sempre extraia o número com `from.split('@')[0]`.
6. **O `sessionId` é definido pelo desenvolvedor** — escolha um nome descritivo e consistente (ex: `ti-suporte`, não `session1`).
7. **Valide o `Authorization` header** no webhook do Next.js para segurança mínima.
