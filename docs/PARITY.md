# Paridade — Claude Desktop → Noishi Desktop

Checklist do que existe, o que difere e o que não existe. Atualizado contra o
código em `apps/desktop/src` (não contra o plano).

Legenda: **OK** implementado e verificado · **PARCIAL** existe com escopo menor ·
**DIFERENTE** existe com escolha própria · **NÃO** não implementado (e por quê).

---

## 1. Janelas

| Superfície | Claude Desktop | Noishi Desktop | Estado |
|---|---|---|---|
| Main | chat + code + cowork | chat + terminal + sandbox | OK |
| Buddy | conversa secundária por projeto | `noishi://buddy?cwd=` com SessionHost próprio | OK |
| Quick | captura rápida (atalho global) | 420×320, `Ctrl+Shift+Space`, botão expandir | OK |
| About | versão + motor | HTML estático + status do tray | OK |
| Artifact | documento compartilhado | `noishi://cowork/shared-artifact?id=`, lê artefato real, exportar | OK |
| Find in page | Ctrl+F | Ctrl+F + menu Editar, contador e prev/next | OK |

## 2. Chat e sessões

| Item | Estado | Observação |
|---|---|---|
| Streaming de texto/thinking/tool | OK | eventos `text_*`, `thinking_*`, `toolcall_*` |
| Markdown + highlight | OK | `marked` + `highlight.js` + `DOMPurify` (sanitizado) |
| Diff derivado dos argumentos | OK | `edit` → `-old/+new`, `write` → só `+` |
| Aprovação de ferramenta | OK | dialogs confirm/select/input/editor |
| Fork por mensagem | OK | botão sob a mensagem, usa `entryId` |
| Clone / Compact / Export | OK | `clone`, `compact`, `exportHtml` |
| Renomear sessão inline | OK | input na lista, `setTitle` |
| Retomar sessão | OK | `listSessions` + `switchSession` + `sessionTranscript` (histórico reconstruído do JSONL) |
| Modelo + thinking level | OK | popover 268px |
| Custo e medidor de contexto | OK | `getSessionStats` + aba Contexto (`sessionCost`, `contextBreakdown`) |
| Steer / follow-up | OK | `steer` (Alt+Enter) e fila de follow-up (Enter durante streaming) |
| Slash commands | OK | `/compact /clear /new /export /model /thinking /help` |
| Histórico de prompts | OK | setas ↑/↓ no composer, 100 entradas em prefs |
| Biblioteca de prompts | OK | salvar/remover/reusar no popover "prompts" |
| Anexos de imagem | OK | colar/arrastar → data URL no composer |
| Composer redimensionável | OK | alça de arraste, altura persistida |
| Voz → prompt | OK | MediaRecorder → `transcribe` (whisper-cli/whisper ou `NOISHI_TRANSCRIBE_URL`) |

## 2b. Arquivos e navegação

| Item | Estado | Observação |
|---|---|---|
| Árvore de arquivos | OK | `readTree` por raiz, expandir/recolher |
| @-mention de arquivo | OK | `searchFiles` no composer, insere `@rel` |
| Drag-drop | OK | imagem vira anexo, texto entra no prompt |
| Abrir no editor | OK | `openFile` → `$EDITOR`/`xdg-open` |
| Busca global em sessões | OK | `searchSessions` com snippet e papel |
| Pastas/tags de sessão | OK | `setSessionFolder` + `listFolders`, chips na lista |
| Multi-root | OK | até 4 raízes por janela |

## 2c. Revisão, git e contexto

| Item | Estado | Observação |
|---|---|---|
| Aplicar/rejeitar diff | OK | `applyDiff` (patch unificado validado) e `revertFile` |
| Reverter arquivo | OK | checkpoint pré-escrita por turno |
| Checkpoint de sessão | OK | `snapshotFile` no `toolcall_end`, `rewindTo` |
| Diff acumulado | OK | `sessionDiff`: pré-imagem mais antiga vs. disco |
| Política de aprovação | OK | regras tool+glob, primeira que casa decide |
| Diff lado a lado | OK | alternância no painel de revisão |
| Word-level diff | OK | pares removido/adicionado com tokens marcados |
| Blame inline | OK | `gitBlame` por arquivo |
| Conflito de merge | OK | `gitConflicts` + escolher ours/theirs |
| Painel git | OK | status, stage/unstage, descartar, diff |
| Commit da sessão | OK | `gitCommitSession` (só arquivos da sessão) |
| Worktree por sessão | OK | `gitWorktreeForSession` (branch `noishi/<id>`) |
| Inspetor de contexto | OK | composição por papel + maiores blocos |
| Guarda de orçamento | OK | aviso e parada por `budget.warnUsd/stopUsd` |
| Custo por sessão | OK | tokens/custo por modelo, duração |
| Export md/pdf | OK | `exportMarkdown`, `exportPdf` (printToPDF) |
| Histórico incremental | OK | `sessionTranscript` ao retomar |
| Portar sessão | OK | `portSession` reescreve o cwd no JSONL |

## 3. Terminal

| Item | Estado |
|---|---|
| PTY por janela (node-pty) | OK |
| xterm.js + FitAddon + ResizeObserver | OK |
| Dispose no fechamento e no quit | OK |
| Separado do `bash` do agente | OK |

## 4. Sandbox (ex-"Cowork")

| Item | Claude Desktop | Noishi Desktop | Estado |
|---|---|---|---|
| VM local headless | QEMU + OVMF | QEMU/KVM, boot direto por kernel | DIFERENTE (sem OVMF, desnecessário no boot direto) |
| Workspace compartilhado | virtiofs | virtiofsd → `/workspace` | OK |
| Canal host↔guest | vhost-vsock | console serial em socket Unix | DIFERENTE |
| Rede | allowlist + MITM proxy | `restrict=on` + proxy de egress com allowlist por domínio | OK (sem MITM) |
| Tarefas com progresso | OK | `runTask` + eventos | OK |
| Artefatos | OK | `artifacts/<id>/artifact.md` + meta | OK |
| Compartilhar artefato | deep link | deep link + janela | OK |
| Guest agent rico | daemon próprio | shell + perfil; toolchain via `apk` | PARCIAL |
| Imagem com toolchain | pré-instalada | `sandboxProvision` instala via `apk` pela allowlist e grava `toolchain.txt`; o boot seguinte reaplica | OK |
| VMs paralelas | — | `sandboxCreateInstance`/`DestroyInstance`, seletor na aba | OK |
| Tarefa agendada | — | `sandboxSchedule` (intervalo mínimo 30 s) | OK |
| Diff do workspace | — | `sandboxWorkspaceDiff` contra `__baseline__` | OK |
| Snapshots do workspace | — | `sandboxSnapshot`/`RestoreSnapshot`/`ListSnapshots` | OK |
| Limites por tarefa | — | vCPU/RAM/timeout na UI, persistidos em prefs | OK |
| Allowlist na UI | — | textarea em Ajustes → `sandboxAllowlist` | OK |
| Terminal interativo na VM | — | xterm sobre o console serial (`sandboxTty`) | OK |

## 5. Extensões

| Item | Estado | Observação |
|---|---|---|
| Instalar `.mcpb` / `.skill` | OK | zip validado, registra em `~/.noishi/agent` |
| Listar | OK | popover |
| Ativar / desativar MCP | OK | move entre `mcpServers` e `disabledMcpServers` |
| Remover | OK | para skill e MCP |
| MIME de pacote + actions | OK | `.deb` via postinst; usuário via boot |
| Native host (extensão de navegador) | OK | manifest instalado em 6 navegadores |
| Extensão MV3 | OK | action + context menu, ID determinístico |

## 6. Integração de sistema

| Item | Estado | Observação |
|---|---|---|
| Deep links `noishi://` | OK | chat/new, code/new, code/continue, code/needs-input, buddy, cowork/shared-artifact, chat/share |
| Single instance | OK | segunda instância roteia |
| Tray | OK | SNI 22px, menu reaplicado; falha é explícita |
| Minimizar para tray | OK | automático quando há tray; `--minimize-to-tray=false` desliga |
| Notificações nativas | OK | turno concluído e `notify`, só com janela oculta |
| GNOME search provider | OK | gjs D-Bus (SearchProvider2), instalado no boot |
| Arquivo de pacote ao clicar | OK | argv + associação de MIME |

## 7. Empacotamento

| Item | Estado |
|---|---|
| AppImage x64 / arm64 | OK (CI) |
| `.deb` x64 | OK |
| Ícones hicolor 7 tamanhos | OK |
| `.desktop` com MimeType + actions | OK |
| chrome-sandbox setuid fallback (postinst) | OK |
| CI: typecheck + build + package + smoke headless | OK |
| Lint | OK (`npm run lint`) |
| Fixtures de contrato do RPC | OK (`npm run probe:contract`, 17/17) |
| Fixtures de revisão (patch/glob) | OK (`npm run probe:review`, 15/15) |
| Fixtures de insights (custo/export) | OK (`npm run probe:insights`, 10/10) |
| E2E de UI (abas/painéis/diagnóstico) | OK (`npm run probe:panels`, 11/11) |
| Auditoria a11y | OK (`npm run probe:a11y`, 11/11) |
| E2E de revisão/git/sistema | OK (`probe/review-e2e.mjs`, `probe/git-e2e.mjs`, `probe/system-e2e.mjs`) |
| E2E de checkpoint/rewind | OK (`probe/rewind-e2e.mjs`) |
| E2E do sandbox | OK (`npm run probe:sandbox`: boot, apk, tarefa, snapshot, TTY) |

## 8. Diferenças deliberadas

| Claude Desktop | Noishi Desktop | Por quê |
|---|---|---|
| Rede do cowork com MITM TLS | proxy sem inspeção | inspeção de conteúdo só com requisito de auditoria; allowlist já limita destino |
| Guest agent binário fechado | shell + perfil | binários da Anthropic não são reaproveitáveis (licença) |
| Co-work como produto separado | aba "Sandbox" na mesma janela | menor superfície; o fluxo é o mesmo |
| Nome "Cowork" | "Sandbox" | "Claude Cowork" é marca da Anthropic |

## 9. Não implementado

| Item | Por quê |
|---|---|
| Inspeção de conteúdo no egress (MITM) | não é requisito; allowlist por domínio cobre o caso de uso |
| Imagem de sandbox com toolchain pré-instalada | próximo passo natural; hoje `apk add` dentro da tarefa |
| Guest daemon persistente (vsock) | serial atende; vsock é otimização |
| `getEntries` na UI | o histórico vem de `sessionTranscript` (JSONL), que já cobre retomar sessão |
