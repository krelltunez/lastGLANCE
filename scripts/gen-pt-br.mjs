#!/usr/bin/env node
// Regenerate public/locales/pt-BR/translation.json from the European file.
//
// pt-BR is DERIVED — do not edit it by hand. Fix the rule (or add a per-key
// override) here and re-run:
//
//   node scripts/gen-pt-br.mjs
//
// The transform is a pure function of pt-PT/translation.json, so re-running it
// after the European file gains keys adds exactly those keys and alters
// nothing else. src/localeVariants.test.ts holds the output to zero European
// markers; anything novel the rules miss fails there.
//
// Rules are ordered most-specific-first. The specific entries are not
// redundant with the general ones below them: they carry the gender agreement
// that plain substitution strands. "cópia de segurança" (feminine) becomes
// "backup" (masculine), so every determiner before it and adjective after it
// has to flip with it — "Nenhuma cópia de segurança remota encontrada" is
// "Nenhum backup remoto encontrado", four words changed for one noun. Same for
// aplicação -> aplicativo, app (f -> m), ecrã -> tela (m -> f), casa de banho
// -> banheiro (f -> m), funções -> recursos (f -> m).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(root, 'public/locales/pt-PT/translation.json')
// An argument overrides the destination — src/locales.test.ts regenerates to a
// scratch path and diffs it against the committed file to catch a stale pt-BR.
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'public/locales/pt-BR/translation.json')

// [european pattern, brazilian replacement] — applied in order to every string.
const RULES = [
  // ── backup: cópia de segurança (f) -> backup (m), agreement first ──
  ['Nenhuma cópia de segurança remota encontrada', 'Nenhum backup remoto encontrado'],
  ['Essa cópia de segurança está vazia', 'Esse backup está vazio'],
  ['O ficheiro não é uma cópia de segurança válida', 'O arquivo não é um backup válido'],
  ['pela cópia de segurança remota', 'pelo backup remoto'],
  ['as cópias de segurança remotas', 'os backups remotos'],
  ['cópia de segurança remota', 'backup remoto'],
  ['cópias de segurança remotas', 'backups remotos'],
  ['Cópias de segurança remotas', 'Backups remotos'],
  ['Cópia de segurança automática', 'Backup automático'],
  ['evitar cópias duplicadas', 'evitar backups duplicados'],
  ['pela cópia de segurança', 'pelo backup'],
  ['uma cópia de segurança', 'um backup'],
  ['a cópia de segurança', 'o backup'],
  ['as cópias de segurança', 'os backups'],
  ['A transferir cópia de segurança', 'Baixando backup'],
  ['Cópia de segurança e restauro', 'Backup e restauração'],
  ['cópias de segurança', 'backups'],
  ['cópia de segurança', 'backup'],
  ['Cópia de segurança', 'Backup'],

  // ── aplicação (f) -> aplicativo (m) ──
  ['pertence a outra aplicação', 'pertence a outro aplicativo'],
  ['Atualize a aplicação', 'Atualize o aplicativo'],
  ['a aplicação está desbloqueada', 'o aplicativo está desbloqueado'],
  ['aplicações', 'aplicativos'],
  ['aplicação', 'aplicativo'],

  // ── app is feminine in Portugal, masculine in Brazil ──
  ['qualquer app instalada', 'qualquer app instalado'],
  ['outras apps de automação', 'outros apps de automação'],
  ['os dados da app', 'os dados do app'],
  ['todas as apps GLANCE', 'todos os apps GLANCE'],

  // ── ecrã (m) -> tela (f) ──
  ['Widgets do ecrã inicial', 'Widgets da tela inicial'],
  ['do ecrã', 'da tela'],
  ['o ecrã', 'a tela'],
  ['ecrãs', 'telas'],
  ['ecrã', 'tela'],

  // ── casa de banho (f) -> banheiro (m) ──
  ['a casa de banho da frente', 'o banheiro da frente'],
  ['casa de banho', 'banheiro'],

  // ── funções (f) -> recursos (m) ──
  ['todas as funções', 'todos os recursos'],

  // ── mosaicos (Quick Settings tiles) are "blocos" on Brazilian Android ──
  ['mosaicos rápidos', 'blocos rápidos'],

  // ── files, users, settings, screens ──
  ['ficheiros', 'arquivos'],
  ['ficheiro', 'arquivo'],
  ['Ficheiros', 'Arquivos'],
  ['Ficheiro', 'Arquivo'],
  // Fake-credential placeholders stay ASCII and drop the European article.
  ['o-seu-nome-de-utilizador', 'seu-nome-de-usuario'],
  ['https://o-seu-servidor', 'https://seu-servidor'],
  ['dav/files/utilizador/', 'dav/files/usuario/'],
  ['utilizadores', 'usuários'],
  ['utilizador', 'usuário'],
  ['Utilizadores', 'Usuários'],
  ['Utilizador', 'Usuário'],
  ['multiutilizador', 'multiusuário'],
  ['definições', 'configurações'],
  ['Definições', 'Configurações'],
  ['por predefinição', 'por padrão'],

  // ── passwords and passphrases ──
  // The suite's Brazilian term for the sync passphrase is "frase de
  // sincronização" (established in dayGLANCE pt-BR). A differently qualified
  // frase-passe keeps its own qualifier instead of having the sync one
  // stacked on: "frase-passe de encriptação" is "frase de criptografia",
  // never "frase de sincronização de criptografia".
  ['frase-passe de sincronização', 'frase de sincronização'],
  ['Frase-passe de sincronização', 'Frase de sincronização'],
  ['frase-passe de encriptação', 'frase de criptografia'],
  ['frases-passe', 'frases de sincronização'],
  ['frase-passe', 'frase de sincronização'],
  ['Frase-passe', 'Frase de sincronização'],
  ['gestor de palavras-passe', 'gerenciador de senhas'],
  ['palavras-passe', 'senhas'],
  ['a palavra-passe', 'a senha'],
  ['Palavra-passe', 'Senha'],
  ['palavra-passe', 'senha'],

  // ── encryption ──
  ['Encriptação', 'Criptografia'],
  ['encriptação', 'criptografia'],
  ['Encriptar', 'Criptografar'],
  ['encriptar', 'criptografar'],
  ['encriptada', 'criptografada'],
  ['encriptado', 'criptografado'],
  ['encriptados', 'criptografados'],

  // ── connection: ligação (kept out of the marker lists — it is a phone
  // call in Brazil — but this app's UI sense is always "connection") ──
  ['Ligação falhada', 'Conexão falhou'],
  ['ligações', 'conexões'],
  ['ligação', 'conexão'],
  ['Ligação', 'Conexão'],
  ['Ligado', 'Conectado'],

  // ── sign-in ──
  ['o início de sessão', 'o login'],
  ['Falha ao iniciar sessão', 'Falha ao fazer login'],

  // ── verbs: registar -> registrar, guardar -> salvar, transferir ->
  //    baixar (download sense), eliminar -> excluir, partilhar ->
  //    compartilhar, gerir -> gerenciar ──
  ['A registar…', 'Registrando…'],
  ['registar', 'registrar'],
  ['Registar', 'Registrar'],
  ['Registado!', 'Registrado!'],
  ['registado', 'registrado'],
  ['registos', 'registros'],
  ['registo', 'registro'],
  ['Registo', 'Registro'],
  ['A guardar…', 'Salvando…'],
  ['Guardar e fechar', 'Salvar e fechar'],
  ['Guardar', 'Salvar'],
  ['Falha ao guardar', 'Falha ao salvar'],
  ['após guardar', 'após salvar'],
  ['foram guardados', 'foram salvos'],
  ['são guardadas automaticamente', 'são salvas automaticamente'],
  ['estão guardadas neste dispositivo', 'estão salvas neste dispositivo'],
  ['Transferir todos os dados', 'Baixar todos os dados'],
  ['transferir a', 'baixar a'],
  ['transferir o', 'baixar o'],
  ['Eliminar', 'Excluir'],
  ['eliminado', 'excluído'],
  ['partilhadas', 'compartilhadas'],
  ['partilhados', 'compartilhados'],
  ['Gerir subscrição', 'Gerenciar assinatura'],
  ['quem gere', 'quem gerencia'],
  // "pedidos" is fine in both, but Brazil says "solicitações" for the
  // HTTP sense the rate-limit message is about.
  ['recebeu demasiados pedidos', 'recebeu solicitações demais'],

  // ── progressives: Portugal's "a + infinitive", Brazil's gerund ──
  ['A aguardar chave', 'Aguardando chave'],
  ['A carregar…', 'Carregando…'],
  ['A restaurar…', 'Restaurando…'],
  ['A exportar…', 'Exportando…'],
  ['A limpar…', 'Limpando…'],
  ['A concluir a configuração', 'Concluindo a configuração'],
  ['está a sincronizar', 'está sincronizando'],

  // ── clitic placement: Portugal proclisis to the infinitive ("para os
  //    ativar"), Brazil enclisis ("para ativá-los") ──
  ['para os ativar', 'para ativá-los'],

  // ── "precisa de/tem de + infinitive" loses the "de" in Brazil ──
  ['precisa de tentar', 'precisa tentar'],
  ['precisa de ser', 'precisa ser'],
  ['tem de corresponder', 'precisa corresponder'],

  // ── contact / subscribe / restore / fail / provider ──
  ['contactar', 'contatar'],
  ['Contactar', 'Contatar'],
  ['contactos', 'contatos'],
  ['contacto', 'contato'],
  ['Contactos', 'Contatos'],
  ['Contacto', 'Contato'],
  ['subscrições', 'assinaturas'],
  ['subscrição', 'assinatura'],
  ['Subscrição', 'Assinatura'],
  ['Restauro falhado.', 'Restauração falhou.'],
  ['restauro', 'restauração'],
  ['Restauro', 'Restauração'],
  ['Importação falhada', 'Importação falhou'],
  ['Sincronização falhada', 'Sincronização falhou'],
  ['Configuração falhada', 'Configuração falhou'],
  ['Falhado', 'Falhou'],
  ['Fornecedor', 'Provedor'],

  // ── odds and ends ──
  ['Tem a certeza?', 'Tem certeza?'],
  ['Reintroduza', 'Digite novamente'],
  ['Introduza', 'Digite'],
  ['introduza', 'digite'],
  ['Largar aqui', 'Solte aqui'],
  ['Comece a escrever', 'Comece a digitar'],
  ['Termos de utilização', 'Termos de uso'],
  ['vista principal', 'visualização principal'],
  ['do agregado familiar', 'da família'],
  ['agregado familiar', 'família'],
  ['atribuído a si', 'atribuído a você'],
  ['é altura de', 'é hora de'],
  ['Multimédia', 'Multimídia'],
  ['Desporto', 'Esporte'],
  ['investigação', 'pesquisa'],
]

// Whole-string replacements for the handful of sentences a word-level rule
// cannot rebuild — passive reordering and the addressee pronoun.
const OVERRIDES = {
  // The desktop app's MCP and Stream Deck settings: conectar (ligar is
  // European), excluir (eliminar), desfazer, no terminal, seus without the
  // article, proclisis (os desconecta), você.
  'localIntegrations.intro':
    "Permite que outros programas deste computador usem o lastGLANCE. Ambos escutam apenas neste computador (127.0.0.1) e nunca podem ser acessados pela rede.",
  'localIntegrations.streamDeckHint':
    "Permite que o plugin do lastGLANCE para Stream Deck mostre suas tarefas e as marque como feitas (porta {{port}}).",
  'localIntegrations.mcpHint':
    "Permite que um assistente de IA compatível com MCP, como o Claude, leia seus dados do lastGLANCE.",
  'localIntegrations.writesHint':
    "O assistente poderá marcar tarefas como feitas, adicionar e editar tarefas e Pessoas, e registrar contatos. Ele nunca poderá excluir nada, e você pode desfazer as alterações dele.",
  'localIntegrations.tokenHint':
    "Os assistentes conectados precisam deste token. Um novo token os desconecta até que eles o recebam.",
  'localIntegrations.portHint':
    "Mude a porta apenas se outro programa já a usar. Deixe em branco para usar a porta padrão.",
  'localIntegrations.writesPaused':
    "As alterações foram pausadas depois de muitas seguidas. Reinicie o lastGLANCE para permiti-las de novo.",
  'localIntegrations.changesHint': "Só nesta sessão. Desfazer mantém o que você alterou desde então.",
  'localIntegrations.undoResult': "Desfeitas: {{undone}}. Mantidas porque mudaram desde então: {{kept}}.",
  'menu.trayMcpOff': "Desativar o acesso de assistentes",
  'localIntegrations.errorPortInUse': "A porta {{port}} já está sendo usada por outro programa.",
  'localIntegrations.claudeCodeHint': "Execute isto no terminal para conectar o Claude Code.",
  'localIntegrations.consentBase':
    "O que o assistente lê é enviado à empresa que o opera (no caso do Claude, a Anthropic) e tratado segundo os termos dela, não os do lastGLANCE. Ative isto apenas para um assistente a quem você confia suas tarefas e sua casa.",
  'localIntegrations.consentPeople':
    "Pessoas contém informações sobre outras pessoas: nomes, aniversários, as anotações que você guarda sobre elas e quando vocês se falaram pela última vez. Elas não concordaram em compartilhar isso com um assistente de IA. Inclua Pessoas apenas se você estiver à vontade com isso.",
  'localIntegrations.consentWrites':
    "O assistente poderá alterar seus dados sem perguntar a você a cada vez. Ele pode fazer no máximo 30 alterações por minuto, nunca pode excluir nada, e você pode desfazer as alterações dele aqui.",
  // The tray search and global shortcuts: buscar, registrar, de qualquer
  // lugar, pressione, digitação, o app (masculine in Brazil).
  'tray.searchPlaceholder': "Buscar tarefas",
  'tray.searchClear': "Limpar busca",
  'settings.shortcutPopupHint': "Abrir o popup de qualquer lugar, para buscar e registrar uma tarefa.",
  'settings.shortcutWindowHint': "Mostrar a janela do lastGLANCE de qualquer lugar.",
  'settings.shortcutPlaceholder': "Clique e pressione um atalho…",
  'settings.shortcutNeedsModifier': "Inclua Ctrl, Alt ou Cmd, para que o atalho não atrapalhe a digitação.",
  'settings.shortcutTaken': "Não foi possível definir esse atalho. Talvez outro app já o use.",
  // The desktop update notice: Baixar (Transferir is European).
  'update.download': "Baixar",
  // Automatic time format: configuração (definição is European).
  'settings.timeAutoHint': "Automático segue a configuração de relógio do seu dispositivo ({{example}}).",
  // The desktop tray: no momento (de momento is European).
  'tray.nothingDue': "Nada pendente no momento.",
  // The desktop app's background mode: bandeja do sistema, fazer login,
  // continuam chegando (the gerund), você.
  'settings.keepRunningHint':
    "Ao fechar a janela, o lastGLANCE fica na bandeja do sistema e os lembretes continuam chegando.",
  'settings.openAtLogin': "Abrir ao fazer login",
  'settings.openAtLoginHint':
    "Iniciar o lastGLANCE quando você fizer login neste computador.",
  'menu.backgroundBody':
    "Os lembretes continuam chegando com a janela fechada. Abra o lastGLANCE pela bandeja do sistema.",
  // iCloud and Direct Access hints that name the Mac and desktop apps:
  // seu without the article, ficar for manter-se, o app (masculine in Brazil).
  'icloud.onHint':
    "Suas tarefas e Pessoas ficam em dia em todo iPhone, iPad e Mac com seu ID Apple. Nada para configurar.",
  'integration.icloudIntents.hint':
    "Troque intents com o dayGLANCE neste dispositivo pelo iCloud, sem mais nada para configurar. No dayGLANCE, os intents do iCloud também precisam estar ativados.",
  'sync.directAccess.unsupported':
    "Disponível nos apps para Android, iOS e computador.",
  // Desktop private-address permission (sync.privateAddress), as dayGLANCE's
  // reviewed pt-BR has it: conectar (not ligar), acessar, em uma, você.
  'sync.privateAddress.needsPermission':
    "{{origin}} está em uma rede privada, então o lastGLANCE precisa da sua permissão para se conectar. O servidor ainda não foi contatado.",
  'sync.privateAddress.refused':
    "{{origin}} é um endereço reservado ao qual o lastGLANCE não se conecta.",
  'sync.privateAddress.allowHint':
    "O lastGLANCE pedirá sua confirmação. Permita apenas endereços da sua própria rede.",
  'sync.privateAddress.consentQuestion':
    "Permitir que o lastGLANCE se conecte a este endereço?",
  'sync.privateAddress.consentResolvesTo':
    "Ele aponta para um endereço de rede privada:",
  'sync.privateAddress.consentWarning':
    "Só permita se for o seu próprio servidor, na sua própria rede (uma rede doméstica ou de escritório, um host Docker ou uma VPN como o Tailscale). O lastGLANCE poderá acessá-lo, e tudo o que ele retornar passará a fazer parte dos seus dados.",
  'sync.privateAddress.consentWarningLoopbackVault':
    "Este endereço é um serviço em execução neste computador. Só permita se for o seu próprio GLANCEvault e a porta for aquela em que ele escuta. Outros programas nesta máquina ficam acessíveis em outras portas, e esta permissão não os abrange.",
  'sync.privateAddress.consentWarningLoopbackServer':
    "Este endereço é um serviço em execução neste computador. Só permita se for o seu próprio servidor de sincronização e a porta for aquela em que ele escuta. Outros programas nesta máquina ficam acessíveis em outras portas, e esta permissão não os abrange.",
  'sync.privateAddress.consentScope':
    "Isso vale apenas para este endereço. Você pode removê-lo depois em Configurações, em Sincronização na nuvem.",
  // Desktop application menu (Windows and Linux), as dayGLANCE's pt-BR has it.
  // Menu verbs differ by country rather than by spelling (Exibir, Desfazer,
  // Recortar), and "ecrã inteiro" (m) would come out as "tela inteiro".
  'menu.view': 'Exibir',
  'menu.undo': 'Desfazer',
  'menu.cut': 'Recortar',
  'menu.toggleDevTools': 'Alternar ferramentas do desenvolvedor',
  'menu.toggleFullScreen': 'Alternar tela cheia',
  // pt-PT "num", "Definições" and "hora" for a clock time read European in Brazil.
  'people.form.notifyHint': 'Entra em um único lembrete por dia. Escolha o horário nas Configurações.',
  'settings.dateRemindersHint': 'Uma notificação em aniversários e outras datas, no horário que você escolher.',
  'settings.digestTimeHint':
    'Quando chega o lembrete diário das pessoas em atraso. Ative para alguém com Lembrar quando estiver em atraso.',
  'settings.reminderTime': 'Horário',
  // Brazilian quotes and gerund for the hidden People switch.
  // "É guardada primeiro uma cópia…" — the fronted feminine passive has no
  // masculine word-for-word counterpart once the noun is "backup".
  'backup.snapshotNote':
    'Primeiro é salvo um backup dos seus dados atuais, para que você possa desfazer esta ação.',
  // "ajuda-o" addresses o senhor/você with a clitic — European usage. Brazil
  // says "ajuda você". ("fazê-lo" further on is fine in both.)
  'welcome.description':
    'O lastGLANCE ajuda você a registrar quando foi a última vez que fez algo e, opcionalmente, a saber quando é hora de fazê-lo novamente.',
  // Settings panel. Brazilian product vocabulary differs here beyond word
  // swaps: Aparência (not Aspeto), Sobre (not Acerca de), Conectar (not
  // Ligar), and "você" phrasing without the European possessive article.
  'settings.appearance': 'Aparência',
  'settings.timeFormat': 'Formato de hora',
  'settings.syncDesc': 'Mantenha suas tarefas e seu histórico sincronizados entre seus dispositivos.',
  'settings.integrationsDesc': 'Conecte o lastGLANCE ao dayGLANCE e a apps de automação.',
  'settings.about': 'Sobre',
  // People mode. Brazilian phrasing beyond word swaps: "você", "conversar",
  // "Apelido" (alcunha), "padrão", "desfazer", and the call channel is a
  // "ligação" in Brazil (the general rule would make it a connection).
  'people.channel.call': 'Ligação',
  'people.home.reachOut': 'Entre em contato',
  'people.contacts.disclosure1': 'O lastGLANCE lê nomes, fotos, aniversários e outras datas, números de telefone e endereços de e-mail dos seus contatos, para você adicionar pessoas sem digitar tudo de novo e ligar, mandar mensagem ou e-mail para elas daqui.',
  'people.contacts.disclosure2': 'No lastGLANCE só são salvos os nomes e as datas que você escolher. Eles só saem do seu celular se você usar a sincronização, com criptografia como o resto dos seus dados. Os números e endereços são lidos quando você toca em Ligar, Mensagem ou E-mail, e a foto de um contato quando você abre essa pessoa. Nada disso é salvo.',
  'people.contacts.denied': 'O acesso aos contatos está desativado. Para usar, permita Contatos para o lastGLANCE nas configurações do celular.',
  'people.contacts.loading': 'Lendo os contatos…',
  'people.contacts.search': 'Buscar contatos',
  'people.contacts.birthdayChanged': 'Nos Contatos, o aniversário de {{name}} é em {{date}}.',
  'people.contacts.keep': 'Manter o meu',
  'settings.phoneContacts': 'Contatos do celular',
  'settings.phoneContactsHint': 'Importe pessoas dos seus contatos e associe-as para ligar, mandar mensagem e e-mail. Somente leitura; números e endereços nunca são salvos nem sincronizados.',
  'people.reason.unreturned': '{{name}} entrou em contato; você ainda não respondeu',
  'people.reason.streak_one': 'Você entrou em contato {{count}} vez seguida',
  'people.reason.streak_other': 'Você entrou em contato {{count}} vezes seguidas',
  'people.snooze.ariaLabel': 'Ocultar {{name}} de Entre em contato por um tempo',
  'people.detail.balance': 'Você {{you}}, a outra pessoa {{them}} · últimos {{days}} dias',
  'people.detail.balanceTooFew': 'Ainda não há registros suficientes para saber quem entra mais em contato',
  'settings.showReciprocityHint': 'Setas, motivos em Entre em contato e o balanço de cada pessoa. Quem entrou em contato continua sendo registrado mesmo oculto.',
  'people.home.emptyCircle': 'Ninguém aqui ainda.',
  'people.home.reachOutEmpty': 'No momento, ninguém está esperando notícias.',
  'people.home.comingUpEmpty': 'Nenhuma data nos próximos 30 dias.',
  'people.direction.outbound': 'Eu entrei em contato',
  'people.direction.inbound': 'A outra pessoa entrou em contato',
  'people.direction.mutual': 'Juntos',
  'people.log.direction': 'Quem tomou a iniciativa',
  'people.empty.body':
    'Adicione as pessoas com quem você quer manter contato, registre quando conversaram pela última vez e o lastGLANCE mostra quem está esperando um oi e quais aniversários estão chegando.',
  'people.detail.noInteractions': 'Nada registrado ainda.',
  'people.detail.deleteDetail':
    'As datas e os contatos registrados só com essa pessoa também serão excluídos. Não é possível desfazer.',
  'people.form.nickname': 'Apelido',
  'people.form.cadencePlaceholder': 'ex.: 2',
  'people.form.dateLabelPlaceholder': 'O que é? (ex.: Dia do santo)',
  'people.form.detailsPlaceholder': 'Nomes dos filhos, gostos, coisas para perguntar…',
  'people.form.cadenceInvalid': 'Digite um número de semanas maior que 0',
  'people.log.when': 'Quando (padrão: agora)',
  'people.log.notePlaceholder': 'Sobre o que vocês conversaram?',
  'people.circles.hint': 'Agrupe as pessoas como quiser. Excluir um círculo mantém as pessoas dele.',
  'people.circles.deleteDetail': 'As pessoas dele continuam, sem círculo.',
  // People intents: Brazil "liga para" and "manda mensagem para", and the
  // European "contactei" and "cronologia".
  'people.intents.task.call': 'Ligar para {{name}}',
  'people.intents.task.callBack': 'Retornar a ligação de {{name}}',
  'people.intents.task.text': 'Mandar mensagem para {{name}}',
  'people.intents.task.email': 'Mandar e-mail para {{name}}',
  'people.intents.task.videoBack': 'Retornar a videochamada de {{name}}',
  'people.intents.timeline.outbound': 'Entrei em contato com {{names}}',
  'people.form.autoSendDayglanceHint': 'Envia para o dayGLANCE uma tarefa como “Ligar para Sam” quando estiver em atraso.',
  'people.form.sendToLifeglanceHint': 'Cada contato que você registrar com esta pessoa vai para a sua linha do tempo do lifeGLANCE.',
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const COMPILED = RULES.map(([from, to]) => [new RegExp(escape(from), 'g'), to])

function transform(value, keyPath) {
  if (keyPath in OVERRIDES) return OVERRIDES[keyPath]
  let out = value
  for (const [re, to] of COMPILED) out = out.replace(re, to)
  return out
}

function walk(node, prefix = '') {
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => {
      const keyPath = prefix ? `${prefix}.${k}` : k
      return [k, typeof v === 'string' ? transform(v, keyPath) : walk(v, keyPath)]
    }),
  )
}

const source = JSON.parse(fs.readFileSync(SRC, 'utf8'))
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(walk(source), null, 2) + '\n')
console.log(`wrote ${path.relative(root, OUT)}`)
