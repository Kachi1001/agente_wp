Documentação Completa: whatsapp-web.js

Esta documentação fornece uma visão técnica aprofundada da biblioteca whatsapp-web.js, uma ferramenta de automação para WhatsApp que opera via navegador utilizando o Puppeteer para interagir com o WhatsApp Web.


--------------------------------------------------------------------------------


1. Introdução e Configuração Inicial

A whatsapp-web.js encapsula a aplicação WhatsApp Web em uma instância gerenciada do Chromium. Ao acessar as funções internas da aplicação, ela oferece uma API robusta para desenvolvedores Node.js.

[AVISO] O WhatsApp não permite oficialmente o uso de bots ou clientes não oficiais. O uso desta biblioteca envolve risco real de banimento da conta. Esta ferramenta não deve ser considerada totalmente imune à detecção.

Requisitos de Sistema

* Node.js: v18 ou superior (obrigatório).
* Ambiente: Sistemas com suporte a Chromium/Puppeteer.

Instalação

npm i whatsapp-web.js


Recursos Suportados

Abaixo, a matriz de compatibilidade baseada na versão atual:

Recurso	Status
Multi-Device	✅ Suportado
Enviar/Receber Mensagens	✅ Suportado
Enviar Mídia (Imagens/Áudio/Documentos)	✅ Suportado
Enviar Vídeos	✅ Requer Google Chrome
Enviar Stickers	✅ Suportado
Enviar/Receber Localização	✅ Suportado
Responder Mensagens (Replies)	✅ Suportado
Menções (Usuários e Grupos)	✅ Suportado
Criação de Enquetes (Polls)	✅ Suportado
Gestão de Canais (Channels)	✅ Suportado
Gestão de Grupos (Add/Kick/Promover/Configurações)	✅ Suportado
Bloquear/Desbloquear Contatos	✅ Suportado
Obter Fotos de Perfil e Informações de Contato	✅ Suportado
Reagir a Mensagens	✅ Suportado
Enviar Botões e Listas	❌ Depreciado (Removido pelo WhatsApp)
Votar em Enquetes / Comunidades	🔜 Em breve


--------------------------------------------------------------------------------


2. Estratégias de Autenticação

As authStrategy são fundamentais para a persistência de sessões, evitando que o desenvolvedor precise escanear o QR Code a cada reinicialização do script.

NoAuth Strategy

Estratégia padrão. Não salva nem restaura sessões. Útil apenas para testes rápidos ou ambientes onde a limpeza total de dados é necessária a cada execução.

LocalAuth Strategy

A estratégia mais recomendada para a maioria dos casos de uso.

* Vantagem: Além da sessão, ela persiste o diretório de dados do usuário, o que garante a restauração do histórico de mensagens em contas multi-device.
* Parâmetros:
  * dataPath: Caminho customizado para os arquivos (padrão: .wwebjs_auth).
  * clientId: Identificador para rodar múltiplas sessões independentes no mesmo sistema.

[AVISO] A LocalAuth exige um sistema de arquivos persistente. Por isso, não é compatível com ambientes efêmeros como o Heroku.

RemoteAuth Strategy

Projetada para escalabilidade e ambientes em nuvem, salvando a sessão em bancos de dados.

* Funcionamento: Realiza backups periódicos da sessão. O evento remote_session_saved dispara cerca de 1 minuto após o scan inicial.
* Requisitos: Necessário instalar lojas específicas:
  * MongoDB: npm i wwebjs-mongo
  * AWS S3: npm i wwebjs-aws-s3

Compatibilidade de SO (RemoteAuth)

Status	Sistema Operacional
✅	MacOS
✅	Windows
✅	Ubuntu 20.04 (Compatível com Heroku)

Avisos Críticos de Execução

[AVISO] Em sistemas Linux sem interface gráfica (no-gui), você deve adicionar a flag --no-sandbox nas opções do Puppeteer. Caso execute como root, adicione também --disable-setuid-sandbox.


--------------------------------------------------------------------------------


3. A Classe Client: O Núcleo da API

A classe Client gerencia a conexão, autenticação e os eventos do navegador.

Propriedades Principais

* info: Objeto ClientInfo com dados da conta conectada (WID, pushname, etc).
* pupBrowser: A instância do navegador Puppeteer.
* pupPage: A página específica onde o WhatsApp Web está carregado.

Exemplo de Inicialização com LocalAuth

const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "client-one" }),
    puppeteer: {
        args: ['--no-sandbox'],
        // executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' // Necessário para Vídeos
    }
});

client.initialize();


Principais Métodos

Método	Parâmetros	Retorno	Descrição
initialize()	-	Promise<void>	Inicia o navegador e o processo de autenticação.
sendMessage()	chatId: string, content: string | MessageMedia | Location | Poll | Contact, options?: MessageSendOptions	Promise<Message>	Envia conteúdo para um destinatário específico.
getChats()	-	Promise<Chat[]>	Retorna a lista de todas as conversas carregadas.
logout()	-	Promise<void>	Encerra a sessão e desloga o dispositivo.
requestPairingCode()	phoneNumber: string	Promise<string>	Solicita pareamento via código. O número deve estar no formato internacional sem símbolos (ex: 5511999999999).
getContactById()	contactId: string	Promise<Contact>	Obtém a instância de um contato pelo ID.

Eventos do Client

Evento	Parâmetros do Callback	Momento do Disparo
qr	qr: string	Quando um novo QR Code é gerado para scan.
authenticated	-	Quando o login é validado com sucesso.
remote_session_saved	-	(Apenas RemoteAuth) Quando a sessão foi persistida no DB.
ready	-	Quando o cliente carregou todos os dados e está operacional.
message	message: Message	Quando uma nova mensagem de terceiros é recebida.
message_create	message: Message	Quando qualquer mensagem é criada (incluindo as enviadas por você).
disconnected	reason: WAState | "LOGOUT"	Quando a conexão é perdida ou o usuário desloga.


--------------------------------------------------------------------------------


4. Manipulação de Mensagens e Mídia

A Classe Message

Representa uma mensagem. Propriedades fundamentais: body, from, to, hasMedia, timestamp, fromMe.

Métodos de Message

* reply(content): Responde à mensagem no mesmo chat.
* react(emoji): Envia uma reação. Use string vazia "" para remover.
* delete(everyone, clearMedia): Apaga a mensagem. Se everyone for true, tenta apagar para todos. clearMedia define se apaga o arquivo do disco (padrão true).
* downloadMedia(): Retorna uma Promise<MessageMedia>.

Tratamento de Anexos

Para enviar arquivos, utilize a classe MessageMedia.

Exemplo: Enviando Imagem Local

const { MessageMedia } = require('whatsapp-web.js');

const media = MessageMedia.fromFilePath('./documento.pdf');
client.sendMessage(chatId, media, { caption: 'Segue o arquivo solicitado.' });


Aviso de Compatibilidade (Vídeos e GIFs)

O Chromium (nativo do Puppeteer) não possui licenças para os codecs AAC e H.264. Para enviar vídeos que funcionem no WhatsApp, você deve configurar o executablePath para apontar para uma instalação do Google Chrome:

* macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
* Windows: C:\Program Files\Google\Chrome\Application\chrome.exe
* Linux: /usr/bin/google-chrome-stable


--------------------------------------------------------------------------------


5. Gestão de Conversas (Chats e GroupChat)

Classe Chat

Aplica-se a conversas privadas e grupos.

* Funcionalidades: archive(), unarchive(), mute(unmuteDate), pin(), unpin().
* Controle de Estado: sendSeen() marca como lida. sendStateTyping() simula o status "digitando" por 25 segundos.

Classe GroupChat (Extensão de Chat)

Adiciona métodos administrativos essenciais:

* Participantes: addParticipants([ids]), removeParticipants([ids]).
* Privilégios: promoteParticipants([ids]), demoteParticipants([ids]).
* Configurações:
  * setAddMembersAdminsOnly(bool): Define se apenas admins podem adicionar membros.
  * setInfoAdminsOnly(bool): Define se apenas admins alteram foto/descrição.
  * setMessagesAdminsOnly(bool): Transforma o grupo em um canal de avisos.
* Convites: getInviteCode() retorna o link de convite atual.


--------------------------------------------------------------------------------


6. Gerenciamento de Contatos

A classe Contact permite validar e identificar usuários.

* Identificação Crítica:
  * isWAContact: Indispensável para verificar se um número está realmente registrado no WhatsApp antes de tentar enviar mensagens.
  * isMyContact: Verifica se o contato está na agenda do celular pareado.
  * isBusiness / isGroup: Identifica o tipo de conta.
* Dados de Perfil: getProfilePicUrl() retorna a URL da imagem e getAbout() retorna o "recado".


--------------------------------------------------------------------------------


7. Referência de Tipos Globais e Estados

MessageTypes (Tipos de Mensagem)

Constante	Descrição
TEXT	Mensagem de texto
IMAGE, VIDEO, AUDIO, VOICE	Formatos de mídia
STICKER	Figurinhas
DOCUMENT	Arquivos genéricos
LOCATION	Localização geográfica
POLL_CREATION	Criação de enquete
REACTION	Reação com emoji
REVOKED	Mensagem apagada

WAState (Estados da Conexão)

Estado	Descrição
CONNECTED	Cliente pronto e operante
PAIRING	Aguardando pareamento
CONFLICT	Outra instância do WhatsApp Web foi aberta em outro lugar
UNPAIRED	Dispositivo desconectado do WhatsApp
UNPAIRED_IDLE	Desconectado e aguardando ação
OPENING	Inicializando a conexão

MessageAck (Confirmações)

Valor	Significado
ACK_ERROR	Falha técnica no envio
ACK_PENDING	Ainda não saiu do cliente
ACK_SERVER	Chegou aos servidores do WhatsApp (um check)
ACK_DEVICE	Entregue ao celular do destinatário (dois checks)
ACK_READ	Lida pelo destinatário (checks azuis)
ACK_PLAYED	Áudio ou vídeo visualizado/ouvido


--------------------------------------------------------------------------------


Referência Técnica - whatsapp-web.js v1.34.6
