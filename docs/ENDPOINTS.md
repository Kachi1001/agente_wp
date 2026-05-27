# Manual de Endpoints - Agente WP

Este documento descreve os endpoints disponíveis na API do **Agente WP**, um serviço de integração com WhatsApp.

## Base URL
A URL base para todas as chamadas é: `http://localhost:3005` (ou a porta configurada no seu arquivo `.env`).

---

## 1. Sessões (`/session`)

Gerencia as conexões de instâncias do WhatsApp.

### Listar Sessões
*   **Endpoint:** `GET /session/`
*   **Descrição:** Retorna uma lista de todas as sessões carregadas e seus status atuais.
*   **Resposta:** Array de objetos de sessão.

### Iniciar Sessão
*   **Endpoint:** `POST /session/start/:id`
*   **Parâmetros de URL:** `id` (String) - Identificador único para a sessão.
*   **Descrição:** Inicia o processo de conexão para uma nova sessão ou retoma uma existente.
*   **Resposta:** `202 Accepted`. O processo ocorre em segundo plano.

### Status da Sessão
*   **Endpoint:** `GET /session/status/:id`
*   **Parâmetros de URL:** `id` (String)
*   **Descrição:** Retorna o status detalhado da sessão (CONNECTED, QR_READY, INITIALIZING, etc).
*   **Resposta:** Objeto com `status`, `qrCode` (se disponível), etc.

### Obter QR Code (Imagem)
*   **Endpoint:** `GET /session/qr/:id`
*   **Parâmetros de URL:** `id` (String)
*   **Descrição:** Retorna o QR Code da sessão em formato de imagem (base64/dataURL).
*   **Resposta:** `{ "qrCode": "data:image/png;base64,..." }`

### Parar/Deletar Sessão
*   **Endpoint:** `DELETE /session/stop/:id`
*   **Parâmetros de URL:** `id` (String)
*   **Descrição:** Encerra a conexão e remove os dados de autenticação locais da sessão.

---

## 2. Mensagens (`/message`)

Envio e manipulação de mensagens.

### Enviar Mensagem
*   **Endpoint:** `POST /message/send`
*   **Corpo da Requisição (JSON ou multipart/form-data):**
    *   `sessionId`: ID da sessão conectada.
    *   `to`: Número do destinatário (ex: `5511999999999@c.us`).
    *   `text`: Texto da mensagem.
    *   `file` (Opcional): Arquivo para envio de mídia.
    *   `mediaType` (Opcional): Tipo da mídia (ex: `image`, `document`).
    *   `quotedMessageId` (Opcional): ID da mensagem a ser respondida.

### Editar Mensagem
*   **Endpoint:** `POST /message/edit`
*   **Corpo da Requisição:**
    *   `sessionId`: ID da sessão.
    *   `to`: Número do destinatário.
    *   `messageId`: ID da mensagem original.
    *   `newText`: Novo conteúdo.

### Deletar Mensagem
*   **Endpoint:** `POST /message/delete`
*   **Corpo da Requisição:**
    *   `sessionId`: ID da sessão.
    *   `to`: Número do destinatário.
    *   `messageId`: ID da mensagem.
*   **Descrição:** Apaga a mensagem para todos.

### Reagir a Mensagem
*   **Endpoint:** `POST /message/react`
*   **Corpo da Requisição:**
    *   `sessionId`, `to`, `messageId`, `emoji`.

### Encaminhar Mensagem
*   **Endpoint:** `POST /message/forward`
*   **Corpo da Requisição:**
    *   `sessionId`: ID da sessão.
    *   `from`: De onde a mensagem veio.
    *   `messageId`: ID da mensagem.
    *   `to`: Destinatário final.

### Histórico de Mensagens
*   **Endpoint:** `GET /message/history`
*   **Query Params:**
    *   `sessionId`: ID da sessão.
    *   `number`: Número do chat.
    *   `limit` (Opcional): Quantidade de mensagens (padrão 200).

---

## 3. Contatos e Verificação (`/contact`)

### Listar Contatos
*   **Endpoint:** `GET /contact/:sessionId/list`
*   **Descrição:** Retorna a lista de contatos salvos no telefone da sessão.

### Verificar Número
*   **Endpoint:** `GET /contact/:sessionId/check/:number`
*   **Descrição:** Verifica se o número informado possui conta no WhatsApp e retorna o JID correto.

---

## 4. Grupos (`/group`)

### Listar Grupos
*   **Endpoint:** `GET /group/list/:sessionId`
*   **Descrição:** Retorna todos os grupos de que a sessão participa.

---

## 5. Utilidades

### Health Check
*   **Endpoint:** `GET /health`
*   **Descrição:** Verifica se o serviço está online.

---

## 6. Integração via Socket.IO

A aplicação também permite comunicação em tempo real via WebSockets.

### Conexão
*   **Namespace:** `/`
*   **Query Params:** `sessionId` (Opcional) - Se fornecido, o socket entra automaticamente na sala da sessão.

### Eventos de Entrada (Escutados pelo Servidor)
*   `join_session`: { `sessionId` } - Entra na sala de uma sessão específica para receber eventos dela.
*   `get_status`: { `sessionId` } - Solicita o status atual da sessão.
*   `send_message`: { `sessionId`, `to`, `text`, `mediaType` } - Envia uma mensagem de texto ou mídia.

### Eventos de Saída (Enviados para o Cliente)
*   `current_status`: Retorna o status da sessão ao conectar ou entrar nela.
*   `events`: Evento genérico que encapsula atualizações de status, QR codes e novas mensagens recebidas.
*   `qr`: Enviado quando um novo QR code é gerado.
*   `ready`: Enviado quando a sessão está conectada e pronta.
*   `message`: Enviado quando uma nova mensagem é recebida na sessão.
