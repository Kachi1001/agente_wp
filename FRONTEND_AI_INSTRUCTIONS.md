# Instruções para a IA do Projeto Frontend (Atendimento)

O microserviço `agente_wp` foi atualizado para uma arquitetura de mídia híbrida e performática. Siga estas instruções para adaptar o envio de mensagens e imagens.

---

## 1. Mudança no Formato de Envio (Frontend -> Agente)

O Agente não aceita mais JSON com `mediaUrl` para envio. Agora ele utiliza **`multipart/form-data`** para processar mídias diretamente em memória (sem salvar no disco do Agente).

### Como implementar no Frontend:

Use o objeto `FormData` nativo do JavaScript para encapsular os campos e o arquivo binário.

```javascript
// Exemplo de função de envio
async function sendMessage(data) {
  const formData = new FormData();
  
  // Campos obrigatórios
  formData.append('sessionId', data.sessionId);
  formData.append('to', data.to);
  
  // Texto ou Legenda
  if (data.text) {
    formData.append('text', data.text);
  }
  
  // Se houver arquivo (Blob ou File vindo do input/state)
  if (data.file) {
    formData.append('file', data.file); // O campo DEVE se chamar 'file'
    
    // Opcional: Especificar tipo para PTT (voz)
    if (data.isAudio) {
      formData.append('mediaType', 'ptt');
    }
  }

  const response = await fetch(`${AGENTE_URL}/message/send`, {
    method: 'POST',
    body: formData, // O browser define o Content-Type: multipart/form-data automaticamente
  });

  return response.json();
}
```

---

## 2. Mudança no Recebimento (Agente -> Frontend)

O fluxo de recebimento via **Socket.IO** continua enviando uma URL, mas agora é garantido que a URL é **absoluta** e o arquivo já está disponível no disco do Agente assim que a notificação chega.

### Detalhamento do Evento `message.received`:

O payload agora sempre contém a `mediaUrl` completa se `hasMedia` for true.

```json
{
  "id": "...",
  "text": "...",
  "hasMedia": true,
  "mediaUrl": "http://servidor-agente:3005/media/session-id/file_id.jpg",
  "mediaMime": "image/jpeg"
}
```

---

## 3. Resumo para a IA:
- **Envio**: Mude de `axios.post(url, { json })` para `axios.post(url, formData)`.
- **Campos**: `sessionId`, `to`, `text` (opcional), `file` (binário).
- **Mídia**: Não envie mais `mediaUrl` no corpo do POST; envie o arquivo físico via `FormData`.
