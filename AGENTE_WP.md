# AGENTE_WP — Manual Completo de Integração

> Este documento é a **Bíblia de Integração** do microserviço `agente_wp`.
> Se você é uma **IA assistente** ou desenvolvedor integrando um projeto Next.js a este agente, **este é o ponto de partida obrigatório. Leia tudo antes de escrever qualquer linha de código.**

---

## 🤖 SEÇÃO ZERO — Instruções para IAs (Leia Primeiro)

Esta seção existe para dar contexto suficiente para uma IA desenvolver **de forma correta e segura** em conjunto com o `agente_wp`.

### O que este projeto é

O `agente_wp` é um **microserviço Node.js + TypeScript** que funciona como um **gateway de WhatsApp**. Ele usa a biblioteca `whatsapp-web.js` (Puppeteer/Chromium) para manter sessões de WhatsApp ativas e rotear mensagens para aplicações externas via HTTP.

**Pense nele como:**
> Um servidor que fica de plantão escutando o WhatsApp e repassando mensagens para qualquer aplicação Next.js (ou outra) que estiver registrada.

---

### Mapa do projeto (o que cada arquivo faz)

```
agente_wp/
├── src/
│   ├── index.ts                  # Ponto de entrada. Sobe o Express e carrega sessões salvas.
│   ├── config.ts                 # Variáveis de ambiente (PORT, WEBHOOK_URL, WEBHOOK_SECRET).
│   ├── controllers/
│   │   ├── SessionController.ts  # Recebe requisições HTTP e delega ao SessionManager.
│   │   └── MessageController.ts  # Recebe requisições HTTP e delega ao SessionManager.
│   ├── routes/
│   │   ├── sessionRoutes.ts      # Rotas: /session/start, /session/status, /session/stop
│   │   └── messageRoutes.ts      # Rotas: /message/send
│   └── services/
│       ├── SessionManager.ts     # 🧠 CORAÇÃO do sistema. Cria e gerencia instâncias Client do wwebjs.
│       ├── SocketService.ts      # Gerencia WebSockets para comunicação em tempo real bidirecional.
│       └── NotifyService.ts      # Emite eventos via Socket.IO e faz POST HTTP (Webhook) fallback.
├── auth_keys/                    # ⚠️ NUNCA commitar. Gerado automaticamente.
│   └── session-ti-suporte/       # Dados de autenticação da sessão (Puppeteer LocalAuth).
│       └── session_config.json   # webhookUrl salvo em disco para esta sessão.
├── AGENTE_WP.md                  # Este documento.
├── .env.example                  # Template de variáveis de ambiente.
└── package.json
```

---

### Regras de Ouro para IAs que desenvolvem NESTE projeto

> ⚠️ Estas regras evitam que alterações no agente quebrem os projetos Next.js que dependem dele.

1. **Nunca altere a estrutura do payload de Webhook** (seção 5) sem atualizar TODOS os projetos consumidores.
2. **Nunca quebre a API REST** — os endpoints existentes são contratos públicos.
3. **`SessionManager.ts` é o arquivo mais crítico** — qualquer mudança aqui afeta todas as sessões ativas. Edite com cuidado.
4. **`auth_keys/` é imutável para código** — nunca modifique arquivos dentro desta pasta programaticamente, exceto o `session_config.json`.
5. **Não instale dependências pesadas desnecessariamente** — o `puppeteer` já consome muita RAM. Prefira soluções leves.
6. **Sempre rodar `npm run build` após alterações** para garantir que o TypeScript compila sem erros.
7. **A pasta `auth_keys/` está no `.gitignore`** — nunca a adicione ao controle de versão.

---

### Regras de Ouro para IAs que integram um projeto Next.js AO agente

1. **O `agente_wp` é somente consumível via HTTP** — o Next.js nunca deve importar ou modificar arquivos do `agente_wp`.
2. **Sempre crie o endpoint de webhook primeiro**, só então remova código legado de WhatsApp.
3. **O campo `jid` no payload tem formato `número@c.us`** — extraia o número com `jid.split('@')[0]`.
4. **`fromMe: true` significa mensagem enviada pelo próprio número conectado** — use isso para sincronizar UI, mas não acione bots.
5. **Valide o header `Authorization: Bearer <secret>`** em cada requisição de webhook recebida.
6. **O header `X-Webhook-Cached: true`** indica mensagens que o agente guardou em cache quando o Next.js estava offline. Não acione bots ou fluxos automáticos com essas mensagens.
7. **Sessões são persistidas automaticamente** — se o `agente_wp` reiniciar, ele reconecta todas as sessões salvas. Não chame `/session/start` novamente em ambientes de produção se a sessão já existir.

---

### Fluxo de implementação recomendado para nova integração

```
1. [ ] Ler este documento inteiro.
2. [ ] Verificar se o agente_wp está rodando: GET http://localhost:3005/health
3. [ ] Criar sessão via POST /session/start/:id com o webhookUrl apontando para o Next.js.
4. [ ] Implementar o endpoint de webhook no Next.js (seção 6).
5. [ ] Criar o helper de envio no Next.js (seção 7).
6. [ ] Testar recebimento de mensagem real.
7. [ ] Testar envio de mensagem.
8. [ ] Valide o header Authorization no webhook.
9. [ ] Remover código legado (se existir).
```

---

## 1. O que é e para que serve

O `agente_wp` é um **microserviço Node.js** que age como uma camada intermediária (gateway) entre o protocolo do WhatsApp e suas aplicações Next.js. Ele resolve o problema de ter que embutir a biblioteca do WhatsApp dentro de cada aplicação.

**Responsabilidades do `agente_wp`:**
- Manter conexões ativas com múltiplos números de WhatsApp simultaneamente.
- Receber mensagens do WhatsApp e repassá-las via HTTP (Webhook) para a aplicação correta.
- Receber comandos de envio da aplicação Next.js e disparar mensagens no WhatsApp.
- Persistir autenticação (LocalAuth) para reconectar automaticamente após reinicialização.

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

### Fluxo de ENTRADA (WhatsApp → Front-end / Next.js):
1. O celular conectado à sessão `ti-suporte` recebe uma mensagem.
2. O `agente_wp` captura o evento via **whatsapp-web.js**.
3. Monta um payload JSON padronizado e **emite um evento Socket.IO** (`message.received`).
4. (Fallback persistente) Faz um `HTTP POST` para o `webhookUrl` cadastrado para a sessão `ti-suporte`.
5. Sua aplicação recebe via Socket (instantâneo) ou via Webhook, processa e atualiza a interface.

### Fluxo de SAÍDA (Front-end / Next.js → WhatsApp):
1. A lógica da sua aplicação decide enviar uma resposta (bot ou atendente).
2. O Front-end **emite um evento Socket.IO** `send_message` para o `agente_wp` (ou usa `HTTP POST /message/send`).
3. O `agente_wp` usa a sessão informada para disparar a mensagem/mídia via WhatsApp.
4. Retorna a confirmação de sucesso/erro via callback do Socket (ou requisição HTTP).

---

## 3. Instalação e Execução do Agente

### Pré-requisitos
- Node.js 18+
- Chromium/Puppeteer (instalado automaticamente via `npm install`)

### Rodar em Desenvolvimento
```bash
cd agente_wp
npm install
npm run dev
# Servidor inicia na porta 3005 (configurável via PORT no .env)
```

### Build para Produção
```bash
npm run build  # Compila TypeScript para dist/
npm start       # Executa o código compilado
```

> ⚠️ **IMPORTANTE:** Execute sempre `npm run build` antes de `npm start` em produção. O `npm start` executa `node dist/index.js`, que precisa do build gerado.

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
| `id`      | string | Sim         | Nome único da sessão (ex: `ti-suporte`, `rh-geral`). Sem espaços. |

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

> **PERSISTÊNCIA:** O `webhookUrl` é salvo em disco dentro de `auth_keys/ti-suporte/session_config.json`. Ao reiniciar o `agente_wp`, as sessões reconectam automaticamente sem precisar chamar este endpoint novamente.

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

## 5. Eventos: O que sua Aplicação vai receber

Sempre que um evento ocorrer, o `agente_wp` vai **emitir um evento em tempo real via Socket.IO** e, logo em seguida, fará um `HTTP POST` (Webhook) para o `webhookUrl` cadastrado (se houver). A recomendação principal para interatividade é escutar os eventos via Socket.IO.

### Payload padrão (todas as mensagens)
```json
{
  "eventType": "message.received",
  "session": "ti-suporte",
  "timestamp": "2026-03-03T14:00:00.000Z",
  "data": {
    "id": "BAE5XXXXXXXXXXXX",
    "fromMe": false,
    "jid": "5511999999999@c.us",
    "lid": "5511999999999@c.us",
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
| Campo       | Tipo    | Descrição                                                              |
|-------------|---------|------------------------------------------------------------------------|
| `id`        | string  | ID único da mensagem no WhatsApp                                       |
| `fromMe`    | boolean | `true` se a mensagem foi enviada pelo próprio número conectado         |
| `jid`       | string  | JID do remetente (`número@c.us` ou autor em grupos `@g.us`)           |
| `lid`       | string  | JID do chat (igual ao `jid` em mensagens individuais)                  |
| `text`      | string  | Texto limpo da mensagem (ou legenda da mídia)                          |
| `pushName`  | string  | Nome salvo no WhatsApp do remetente                                    |
| `mediaType` | string  | `text`, `image`, `video`, `audio`, `ptt`, `document` ou `sticker`     |
| `hasMedia`  | boolean | `true` se a mensagem contém mídia                                      |
| `timestamp` | number  | Unix timestamp de quando a mensagem foi enviada                        |
| `raw`       | object  | Objeto `Message` original do `whatsapp-web.js`                         |

### Extraindo o número limpo do campo `jid`
```typescript
const phoneNumber = data.jid.split('@')[0]; // "5511999999999"
```

### Headers enviados pelo agente
```
Content-Type: application/json
Authorization: Bearer <WEBHOOK_SECRET do .env>
```

Seu Next.js **deve validar** esse header para rejeitar webhooks não autorizados.

### Header de Cache
Se o Next.js estiver offline e o Agente reenviar mensagens acumuladas posteriormente, ele enviará um header adicional:
```
X-Webhook-Cached: true
```
Isso permite que sua aplicação saiba que a mensagem não é em tempo real e pode ser ignorada por bots ou tratada como histórico.

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

  // Ignorar mensagens do cache (enviadas quando o servidor estava offline)
  const isCached = req.headers['x-webhook-cached'] === 'true';

  const { session, data } = req.body;
  const phoneNumber = data.jid.split('@')[0];

  console.log(`[${session}] Nova mensagem de ${data.pushName} (${phoneNumber}): ${data.text}`);

  if (!isCached && !data.fromMe) {
    // Sua lógica de negócio aqui (bot, ticket, etc.)
  }

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

## 7. Como Enviar Mensagens a Partir do seu Sistema

A forma **principal e recomendada** é usando um cliente **Socket.IO**, perfeito para painéis de atendimento em tempo real.

### Via Socket.IO (Recomendado - Latência Zero)

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3005');

// Exemplo: Enviar texto
socket.emit('send_message', {
  sessionId: 'ti-suporte',
  to: '5511999999999',
  text: 'Olá via Socket!'
}, (response) => {
  // Opcional: callback para saber se enviou com sucesso
  console.log('Resultado do envio:', response.success ? 'Sucesso' : 'Erro', response);
});

// Exemplo: Enviar mídia
socket.emit('send_message', {
  sessionId: 'ti-suporte',
  to: '5511999999999',
  text: 'Veja esse documento:',
  mediaUrl: 'https://meusite.com/doc.pdf',
  mediaType: 'document'
});
```

### Via API REST (Fallback)

Se estiver chamando a partir de um back-end crons ou jobs (e não quer abrir um Socket), a API REST `/message/send` continua funcionando perfeitamente (veja detalhes na Seção 4.2).

```typescript
import axios from 'axios';

export async function sendWhatsAppMessage(to: string, text: string) {
  return axios.post('http://localhost:3005/message/send', {
    sessionId: 'ti-suporte', // Mude conforme a sessão
    to,
    text,
  });
}
```

---

## 8. Guia de Migração: Substituindo o whatsapp-web.js Local

Se o projeto Next.js usa `whatsapp-web.js` embutido, siga este roteiro:

1. Suba o servidor `agente_wp` (`npm run dev`).
2. Registre a sessão via `POST /session/start/<id>`.
3. Escaneie o QR Code no terminal do agente.
4. Valide com `GET /session/status/<id>` que retornou `"CONNECTED"`.
5. Crie `/api/whatsapp-webhook.ts` conforme a seção 6.
6. Crie o `src/lib/agente.ts` conforme a seção 7.
7. Remova o código do client local (import, listeners, sendMessage).
8. Remova as dependências do Next.js: `npm uninstall whatsapp-web.js puppeteer`.

---

## 9. Sistema de Retry e Cache de Falhas

O `agente_wp` tem uma camada de retry automático nos webhooks. Se o Next.js estiver reiniciando, o agente tentará reenviar automaticamente:

| Tentativa | Espera antes de tentar novamente |
|-----------|----------------------------------|
| 1ª retry  | ~1 segundo                       |
| 2ª retry  | ~2 segundos                      |
| 3ª retry  | ~4 segundos                      |
| 4ª retry  | ~8 segundos                      |
| 5ª retry  | ~16 segundos                     |

Após 5 tentativas, a mensagem é salva em `auth_keys/<sessionId>/webhook_cache.json`. Quando a próxima mensagem for entregue com sucesso, o agente automaticamente reenvia as mensagens cacheadas com o header `X-Webhook-Cached: true`.

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
│       ├── SessionManager.ts     # Gerencia instâncias do whatsapp-web.js (Client + LocalAuth)
│       ├── SocketService.ts      # WebSockets para comunicação bidirecional em tempo real
│       └── NotifyService.ts      # Emite Sockets e POST HTTP para Next.js com retry e cache
├── auth_keys/                # ⚠️ Gerado automaticamente — NUNCA commitar
│   └── session-ti-suporte/   # Dados do Puppeteer (LocalAuth) para a sessão
│       └── session_config.json   # webhookUrl persistido desta sessão
├── AGENTE_WP.md              # Este documento
├── .env.example              # Template de variáveis de ambiente
├── package.json
└── .env                      # ⚠️ NUNCA commitar
```

---

## 11. Considerações de Produção

- **RAM:** O `whatsapp-web.js` executa um navegador Chromium por sessão. Cada sessão consome ~150–300MB de RAM. Monitore seu servidor.
- **Reinicializações:** O agente restaura todas as sessões automaticamente ao iniciar. Não é necessário re-escanear QR Code.
- **Segurança:** O `WEBHOOK_SECRET` deve ser longo e aleatório. Nunca exponha o agente diretamente à internet sem um reverse proxy (nginx/caddy) com HTTPS.
- **Logs:** Todos os eventos são logados via `pino` com suporte a `pino-pretty` em desenvolvimento.
