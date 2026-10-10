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
