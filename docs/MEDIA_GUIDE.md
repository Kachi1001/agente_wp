# Guia de Envio e Recebimento de Mídias

Este documento explica como integrar o envio de arquivos (imagens, áudios, vídeos e documentos) através do Agente WhatsApp.

---

## 1. Envio de Mídia (Frontend → WhatsApp)

Para enviar mídias, o Agente utiliza o padrão `multipart/form-data`. Isso permite que você envie o arquivo diretamente em binário, economizando recursos de memória (sem Base64) e sem ocupar espaço em disco no Agente, já que o arquivo é processado apenas em RAM.

### Endpoint: `POST /message/send`

**Tipo de Conteúdo:** `multipart/form-data`

#### Parâmetros do Formulário:

| Campo | Tipo | Obrigatório | Descrição |
| :--- | :--- | :--- | :--- |
| `sessionId` | String | Sim | ID da sessão conectada no Agente. |
| `to` | String | Sim | Número do destinatário com DDI (ex: `5511999999999`). |
| `text` | String | Não | Legenda da mídia (opcional se houver arquivo). |
| `file` | Arquivo | Sim* | O arquivo binário a ser enviado. |
| `mediaType`| String | Não | Tipo da mídia: `image`, `video`, `audio`, `document`, `ptt`. |

> \* *Se você não enviar o campo `file`, o Agente tratará a requisição como uma mensagem de texto simples usando o campo `text`.*

### Exemplo via cURL:

```bash
curl -X POST http://localhost:3005/message/send \
  -F "sessionId=ti-suporte" \
  -F "to=5511999999999" \
  -F "text=Segue o comprovante em anexo" \
  -F "file=@/caminho/do/seu/arquivo/comprovante.pdf"
```

### Exemplo via Postman ou Insomnia:
1. Altere o método para `POST`.
2. Em `Body`, escolha a opção `form-data`.
3. Adicione as chaves `sessionId`, `to`, `text`.
4. Adicione a chave `file`, mude o tipo de `Text` para `File` e selecione o arquivo do seu computador.

---

## 2. Recebimento de Mídia (WhatsApp → Frontend)

Diferente do envio, o **recebimento** de mídias é automático e o Agente armazena uma cópia local para garantir a persistência.

### Fluxo de Recebimento:

1. O Agente recebe a mensagem com mídia do WhatsApp.
2. Ele baixa o arquivo e o salva na pasta: `public/media/<sessionId>/`.
3. O Agente emite um evento via **Socket.IO** (`message.received`) contendo a `mediaUrl`.

### Objeto de Resposta (Socket):

```json
{
  "id": "MSG_ID_123",
  "fromMe": false,
  "pushName": "João Silva",
  "text": "Foto da reunião",
  "hasMedia": true,
  "mediaType": "image",
  "mediaUrl": "http://localhost:3005/media/ti-suporte/MSG_ID_123.jpg",
  "mediaMime": "image/jpeg",
  "timestamp": 1709645000
}
```

---

## 3. Notas Importantes

- **Performance**: O envio via `multipart/form-data` é disparado e processado em memória. O Agente não guarda cópia do que você envia para não lotar o disco.
- **PTT (Voz)**: Ao enviar um arquivo de áudio, se você definir `mediaType: "ptt"`, ele aparecerá no WhatsApp do destinatário como uma mensagem de voz gravada na hora.
- **SSL/BaseUrl**: Certifique-se de que a variável `BASE_URL` no arquivo `.env` esteja correta para que os links de mídia gerada no recebimento sejam acessíveis externamente.
