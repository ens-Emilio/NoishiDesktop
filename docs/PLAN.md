# Noishi Desktop — Plano de Criação

Data: 2026-11-10 · Repo: `~/AgentCoding/NoishiDesktop` (vazio, só .git)
Decisões: shell Electron próprio (estilo Claude Desktop) · motor = SDK/RPC do NoishiCLI (pi 1.5.0) · escala = paridade com Claude Desktop

---

## 1. Arquitetura

```
┌──────────────────────────── Noishi Desktop (Electron) ────────────────────────────┐
│  main process (TS, electron-vite)                                                  │
│  ├─ index.ts          janelas + ipcMain (router por tipo de comando)               │
│  ├─ session-host     1 ThinRpcClient (JSONL) por sessão; spawn do `noushi rpc`     │
│  ├─ rpc-translate     eventos/UI do pi → contrato do desktop (fixtures em probe/)  │
│  ├─ deep-link         noishi:// (chat/code/buddy/cowork-artifact/share)            │
│  ├─ tray              SNI + menu; minimize-to-tray configurável                    │
│  ├─ find-in-page      webContents.findInPage + barra no renderer                   │
│  ├─ cowork-service    sandbox QEMU/KVM: virtiofsd + proxy de egress               │
│  ├─ sandbox-proxy     allowlist por domínio (npm/PyPI/crates/GitHub/Alpine)        │
│  ├─ mcp-registry      instala/lista/ativa/remove .mcpb e .skill (zip)              │
│  ├─ native-host       chrome-native-messaging p/ extensão de navegador             │
│  ├─ search-provider   instala o provider gjs do GNOME no boot                      │
│  ├─ file-associations MIME x-noishi-package + associação p/ AppImage             │
│  ├─ terminal          node-pty por janela (aba Terminal)                           │
│  └─ janelas           buddy / quick / about / artifact                             │
│                                                                                    │
│  renderer (React + Vite, TypeScript)                                               │
│  ├─ App.tsx           chat, sessões, Sandbox, dialogos, popover, find bar          │
│  ├─ markdown.ts       marked + highlight.js + DOMPurify                            │
│  └─ Terminal.tsx      xterm.js + FitAddon                                          │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ RPC JSONL (stdin/stdout, já implementado no pi: rpc-mode + RpcClient)
        ▼
   NoishiCLI (binário `noushi`, repo NoishiCLI, pin earendil 676af1d, engine 1.5.0)
        ├─ ferramentas: read/write/edit/ast_edit/lsp/bash/process/sqlite/sandbox
        ├─ sessões: new/fork/clone/compact/export
        └─ MCP servers, skills, permissões, audit log (~/.noishi)
```

**Decisões-chave (e por quê):**

1. **Motor via RPC do pi, não re-implementação.** O pi já exporta `RpcClient` (`packages/coding-agent/src/modes/rpc/rpc-client.ts`) com prompt/steer/followUp/abort/fork/compact/bash/modelos/thinking/custo. O desktop vira um *shell* — a lógica de agente permanece no NoishiCLI. Zero duplicação de cérebro.
2. **Electron, não Tauri.** O pi é Node; `RpcClient` usa `child_process`/streams de Node. Electron roda o mesmo código no main sem polyfill. Tauri exigiria reescrever o transporte em Rust.
3. **UI própria, sem copiar assets da Anthropic.** O Claude Desktop extraído (`~/Downloads/claude-desktop/extracted/`) é *referência de features/comportamento* (routes, IPC surface, cowork), não código a reaproveitar — licença proprietária.
4. **Paridade por camadas.** Chat + Code primeiro (núcleo usável), Cowork/MCPB/skills depois (integrações de sistema).

---

## 2. O que herdamos do ecossistema Noishi (sem reescrever)

| Componente | Origem | Uso no Desktop |
|---|---|---|
| `RpcClient` + rpc-mode (JSONL) | NoishiCLI `packages/coding-agent` | transporte de cada sessão |
| Sessões fork/clone/compact | rpc commands `fork`, `clone`, `compact` | botões da sessionsView |
| Modelos/thinking/custo | rpc `getAvailableModels`, `setModel`, `setThinkingLevel`, `getSessionStats` | settingsView + status bar |
| Permissões/segurança | pi core (approval, sandbox bwrap, audit) | respeitados; desktop só renderiza pedidos (`extension` UI requests: confirm/select/input/notify/setStatus/setWidget) |
| Skills/MCP | pi core + `pi-mcp` | mcpRegistry só empacota/instala |
| Marca/config `.noushi` | `piConfig` | mesmo configDir, tema geométrico Noishi |

**Referências de features extraídas do Claude Desktop** (para guiar paridade, não para copiar código):
- rotas deep-link: `chat/new`, `code/new`, `code/continue`, `code/needs-input`, `cowork/shared-artifact`
- janelas: main, buddy, quick, about, artifact (5 — não 7); tray; GNOME search provider; MIME de pacote; native host
- Cowork do Claude = VM QEMU com OVMF/vsock/MITM. O nosso sandbox usa boot direto por kernel, console serial e proxy de egress com allowlist (ver §Fase 4 e PARITY.md)

---

## 3. Estrutura do repo

```
NoishiDesktop/
├─ package.json              workspaces: apps/*, packages/*; scripts build/dev/check/lint/package/start
├─ eslint.config.js          flat config (sem any, sem dynamic import, type-only imports)
├─ apps/
│  └─ desktop/               app Electron (electron-vite + electron-builder)
│     ├─ src/main/           index.ts + services/ (sessão, sandbox, tray, deep-link, …)
│     ├─ src/preload/        contextBridge tipado (window.noishi)
│     ├─ src/renderer/       React: App.tsx, markdown.ts, Terminal.tsx, styles/
│     ├─ build/              icon.png, icons/ (7 tamanhos), search-provider/, after-install.sh
│     ├─ native-host/        host de native messaging + wrapper .sh
│     └─ extension/          extensão MV3 (manifest, background, icons)
├─ packages/
│  ├─ rpc-bridge/            contrato IPC (comandos, eventos, canais, bridge)
│  └─ noishi-sdk/            resolve o binário `noushi` (env, ~/.noishi/bin, PATH)
├─ probe/                    smoke.mjs, rpc-probe.mjs, rpc-contract.mjs, ui-drive.mjs
└─ docs/
   ├─ PLAN.md (este arquivo)
   ├─ UI-PLAN.md             design system e fases de UI
   ├─ PLAN-EXTENSIONS-TERMINAL-TRAY.md
   └─ PARITY.md              checklist Claude Desktop → Noishi Desktop
```

Vínculo com o NoishiCLI: `packages/noishi-sdk` declara `@earendil-works/pi-coding-agent` como dep opcional de *desenvolvimento* (file: para o checkout irmão em `../NoishiCLI`), mas em produção o desktop **spawn o binário `noushi` instalado** — desacopla ciclos de build.

---

## 4. Fases

### Fase 0 — Fundação (meio dia)
- Scaffold do monorepo (npm workspaces, electron-vite, TypeScript strict, ESLint — seguir regras do AGENTS.md do NoishiCLI: sem `any`, sem dynamic imports, erasable TS).
- `noishi-sdk`: detectar binário `noushi` (env `NOUSHI_DESKTOP_CLI` → `~/.noishi/bin/noushi` → PATH), versão mínima, teste de `--version`.
- `rpc-bridge`: tipos dos comandos RPC do pi (prompt/steer/abort/fork/clone/compact/bash/models/thinking/stats) e eventos (`message_update`, `tool_execution`, `extension` UI requests).
- **Aceite:** `RpcClient` abre sessão no checkout do NoishiCLI, prompt de teste responde com stream de eventos.

### Fase 1 — Janela principal + chat (2–3 dias)
- `index.ts` + `createMainWindow`: BrowserWindow main (tema claro/escuro), About, teardown limpo.
- `ipcMain` + preload: canais tipados em `@noishi/rpc-bridge`, sem expor Node ao renderer.
- chatView: lista de mensagens, streaming dos eventos do agente, renderização de markdown/código (highlight), pedidos de ferramenta com approve/deny (extension requests), cancelamento.
- **Aceite:** conversa multi-turno com ferramentas funcionando; custo/contexto visíveis (getSessionStats).

### Fase 2 — Sessões Code (2–3 dias)
- sessionsView: nova sessão (escolha de diretório), retomar (histórico de sessões do pi em `~/.noishi`), fork, clone, compact, export HTML.
- Diffs de arquivo como cards no chat (eventos de tool edit/write com diff).
- Terminal embutido opcional via rpc `bash` (PTY no main, xterm.js no renderer) — v2 se apertar.
- **Aceite:** ciclo completo: criar sessão num repo → pedir implementação → aprovar diffs → retomar depois de fechar o app.

### Fase 3 — Integração de sistema (2–3 dias)
- deep-link `noishi://` (protocol.registerSchemesAsPrivileged + single-instance lock; rotas: `chat/new`, `code/new?cwd=`, `code/continue`, `code/needs-input`).
- Tray (ícones dark/light, menu: nova conversa, nova sessão code, sair) + single-instance focus.
- Notificações nativas (needs-input / conclusão de tarefa em background).
- Multi-janela: buddy_window (conversa secundária por projeto) e quick_window (captura rápida global — atalho do SO).
- **Aceite:** `xdg-open "noishi://code/new?cwd=/tmp/x"` abre o app na sessão certa; tray reflete estado; Ícone/sessões sobrevivem a restart.

### Fase 4 — Cowork (VM sandbox) (1–2 semanas, o maior item)
- Detecção de prereqs (qemu-system-x86, virtiofsd, socat, assets Alpine); UI mostra o que falta e o comando de instalação.
- `cowork-service`: ciclo de vida da VM (qemu headless, virtiofsd p/ workspace, console serial p/ host↔guest) + `sandbox-proxy` (allowlist por domínio no host, `restrict=on` no QEMU).
- Guest: perfil `/etc/profile.d/sandbox.sh` (proxy env, PS1 fixo, cwd) + repo Alpine de rede; toolchain instalado por tarefa via `apk`.
- Painel Sandbox: criação de tarefa, progresso, artefatos, compartilhamento (`noishi://cowork/shared-artifact`).
- **Aceite:** tarefa "rode os testes deste repo num ambiente limpo" executa dentro da VM, rede restrita à allowlist, artefato volta ao chat.

### Fase 5 — Extensões (1 semana)
- mcpRegistry: instalar `.mcpb`/`.skill` (zip validado: manifest + payload), registrar no config do pi (`~/.noishi`), listar/ativar/desativar/remover no popover de extensões.
- chrome-native-host: manifest de native messaging p/ extensão de navegador "compartilhar página com o Noishi" (equivalente do claude-for-chrome).
- GNOME search provider (opcional; D-Bus service file).
- **Aceite:** instalar um MCPB de teste e o agente o usar numa conversa.

### Fase 6 — Empacotamento (2–3 dias)
- electron-builder: AppImage + .deb (não-ambiente Anthropic; sem apt repo na v1), ícones hicolor, .desktop com actions e MIME types (`x-noushi-handler/`, `.nmcpb`, `.nskill`), WMClass `com.noushi.Desktop`.
- Sandboxing: chrome-sandbox setuid fallback + bombeiro de user namespaces (mesma postura do PKGBUILD do Claude).
- CI: build Linux x64 (aarch64 depois), smoke test headless (xvfb) que abre o app, cria sessão com mock de provider e fecha limpo.
- **Aceite:** AppImage e .deb instaláveis no Arch (testado) e Debian-family (lintian-level), launchers e deep-links funcionais.

**Total estimado: ~5–6 semanas de trabalho focado** (Cowork domina; sem ele, o núcleo é ~2–3 semanas).

---

## 5. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| RPC do pi evolui e quebra o bridge | médio | pin no revision do NoishiCLI; testes de contrato no rpc-bridge (fixtures de eventos) |
| Cowork: guest agent é trabalho novo (binários da Anthropic não reaproveitáveis) | alto | Fase 4 isolada; MVP do Cowork só bash na VM, sem daemon rico; alternativa: container (bwrap/docker) como modo "light" |
| contextBridge largo vira superfície de ataque | médio | canais mínimos por janela, validação de `cwd` no main, nunca `nodeIntegration`; seguir padrão do pi (sender validation) |
| Licença: referência vs. implementação | alto se copiado | regra dura: nenhum asset/código da Anthropic no repo; apenas *comportamento* reimplementado; audit no PR |
| Electron ≈ 200MB por instalação | baixo | aceitável (Claude Desktop tem 218MB só no binário) |

## 6. Métricas de sucesso v1
- App abre < 3s, sessão Code responde ao primeiro token < 2s (limitado pelo provider).
- Zero prompts de permissão duplicados entre desktop e pi (desktop só renderiza os pedidos do agente).
- Paridade v1: chat, sessões code com fork/compact, tray, deep-links, MCPB/skills. Cowork funcional mas marcado beta.

---

## Status de execução (2026-11-11)

| Fase | Aceite | Evidência |
|---|---|---|
| 0 | RPC probe PASS (PONG end-to-end) | `probe/rpc-probe.mjs` |
| 1 | Multi-turno + ferramenta `read` + stats ($0.1482 / 29403 tok) na UI | CDP eval |
| 2 | Restart → resume → respondeu "v2" (memória da sessão) | CDP eval |
| 3 | `noishi://code/new?cwd=…` via 2ª instância cria sessão certa | log + transcript |
| 4 | VM Alpine boota, executa `uname`, rede deny-all provada (`ping: Network unreachable`) | CDP eval |
| 5 | `.mcpb` e `.skill` instalados; agente respondeu `SKILL-OK` | transcript |
| 6 | AppImage (108MB) e .deb (75MB) gerados; AppImage lança e conecta | dist/ |

Limitação conhecida: tray SNI não registra no Plasma6 com Electron 33 (falha silenciosa do Electron,
guardada no código — o app segue funcional sem tray).

## Redesign UI estilo Claude Desktop (2026-11-11)

- Rename Noushi→Noishi completo (pacotes, `com.noishi.desktop`, scheme `noishi://`,
  env `NOISHI_*`; o binário da CLI permanece `noushi` — é o nome real do executável).
- Tema escuro alinhado ao design system do Claude Desktop (tokens extraídos do bundle:
  `--cds-surface-1 #191919`, `--cds-surface-2 #1f1f1f`, borders white-alpha,
  `text-primary #ffffffed`, sombra popover `0 8px 24px #00000052`) — CSS puro, sem copiar
  assets da Anthropic.
- Layout: sidebar fixa com sessões, greeting central, composer destacado com sombra.

## Conclusão das fases pendentes (2026-11-11)

- settingsView: seletor de modelo (47 modelos via `getAvailableModels`) + thinking
  level (chips) no rodapé da sidebar.
- coworkView: painel com estado da VM (boot/exec/output) sobre o `CoworkService`.
- Sessões: botão Clonar (rpc `clone`); cards de tool com streaming dos argumentos
  (`toolcall_delta`/`toolcall_end` agora consumidos).
- Cowork exec corrigido: marker curto (console serial quebra linha em 80 colunas),
  protocolo START-primeiro com parse por âncora de linha, resposta DSR do ash
  (`\x1b[1;1R`) sem a qual o shell enfileira o comando digitado.
- CI: smoke headless (`probe/smoke.mjs` sob xvfb) que lança o app, verifica bridge
  + composer e sai limpo.

## Fechamento (2026-11-15)

Depois do sandbox, os itens que faltavam dos três planos:

**Configuração / empacotamento**
- `main` do `package.json` da raiz apontava para `dist/` (o build real é `out/`) —
  `npm start` agora executa o app.
- Ícones em 7 tamanhos (`build/icons/`), `.desktop` com MIME
  `application/x-noishi-package` + `[Desktop Action]` new-chat/new-code.
- `.deb` instala MIME XML e actions via `build/after-install.sh`; AppImage e dev
  run registram o mesmo em `~/.local/share` no boot (`file-associations.ts`).
- Abrir um `.mcpb`/`.skill` (duplo clique ou argv) instala o pacote.

**GNOME search provider (Fase 5)**
- O `.ini` apontava para `noishi.desktop` mas o entry instalado é
  `noishi-desktop.desktop` — nunca casava. Corrigido.
- Provider reescrito em gjs (era um stub que saía na hora): implementa
  `org.gnome.Shell.SearchProvider2`, possui o nome no bus e abre `noishi://chat/new`.
- Instalado de verdade no boot em `~/.local/share/gnome-shell/search-providers`
  e `~/.local/share/dbus-1/services` (`search-provider.ts`). Verificado com `gdbus call`.

**UI**
- Markdown + highlight no chat (`marked`, `highlight.js`), sanitizado com DOMPurify;
  8 casos unitários cobrindo script/handler/link javascript.
- Popover de extensões: ativar/desativar MCP (`disabledMcpServers`) e remover
  skill/MCP, com contador `ativos/total`.
- `find-in-page` (Ctrl+F + menu Editar) via `webContents.findInPage`, com
  contador e prev/next.
- Quick window: botão expandir → foca a janela principal.
- Janela de artefato: botão Exportar (.md).
- Cabeçalho do sandbox mostra vCPU e RAM.
- Buddy window agora assina o próprio SessionHost (antes os eventos RPC do buddy
  nunca chegavam ao renderer).

**Qualidade**
- `eslint.config.js` (flat) + `npm run lint`; código morto removido nos serviços.
- `probe/rpc-contract.mjs`: 17 fixtures do tradutor RPC. Pegou um bug real
  (`agent_end` lia `willRetry` em vez de `aborted`).
- `docs/PARITY.md`: paridade item a item, diferenças deliberadas e o que não
  existe.
- `--minimize-to-tray=false` / `NOISHI_MINIMIZE_TO_TRAY=0` desliga fechar-para-tray.

## Os 50 itens (2026-11-16)

Implementados e verificados contra o app rodando (CDP), não só compilados.

**Composer / RPC (20–27)**
- `steer` (Alt+Enter durante streaming) e fila de follow-up (Enter durante streaming).
- Slash commands locais: `/compact /clear /new /export /model /thinking /help`.
- Histórico de prompts (↑/↓, 100 entradas em prefs) e biblioteca de prompts salvos.
- Anexos de imagem por colar/arrastar; composer redimensionável com altura persistida.
- Voz → prompt: `MediaRecorder` → `transcribe` (whisper-cli/whisper local ou
  `NOISHI_TRANSCRIBE_URL`), com erro explícito quando não há transcritor.

**Arquivos e navegação (8–14)**
- Árvore por raiz (`readTree`), @-mention (`searchFiles`), drag-drop, abrir no
  editor, busca global em sessões, pastas/tags e multi-root (até 4).

**Revisão e git (1–7, 15–19)**
- `services/review.ts`: parse/aplicação de patch unificado com validação de
  contexto, diff acumulado por sessão (pré-imagem mais antiga vs. disco) e a
  política de aprovação (tool + glob, primeira regra que casa).
- Checkpoints reais: `session-host` grava a pré-imagem no `toolcall_end`, antes
  da ferramenta rodar — é o que torna reverter/rewind corretos.
- Painel Revisão: aplicar/rejeitar por arquivo, lado a lado, word-level, blame,
  conflito de merge (ours/theirs).
- Painel Git: status, stage/unstage, descartar, diff, commit, commit da sessão
  (só os arquivos que a sessão tocou) e worktree por sessão.

**Contexto e sessão (28–33)**
- `services/session-insights.ts`: custo por sessão e por modelo, composição do
  contexto, export `.md`/`.pdf` (printToPDF), portar sessão (reescreve o cwd) e
  `sessionTranscript` — retomar sessão agora mostra o histórico.
- Guarda de orçamento: aviso e parada por `budget.warnUsd/stopUsd`.

**Sandbox (34–41)**
- `sandbox-vm.ts` (uma VM) + `cowork-service.ts` (gerente de instâncias):
  VMs paralelas com workspace/artefatos/snapshots próprios.
- `sandboxProvision` instala toolchain via `apk` pela allowlist e grava
  `toolchain.txt` no diretório da instância, reaplicado no boot seguinte (o
  disco do guest é efêmero) — verificado com `jq` antes e depois de reiniciar.
- Diff do workspace contra baseline; snapshots criar/restaurar/listar; tarefas
  agendadas; limites (vCPU/RAM/timeout) na UI; allowlist editável em Ajustes;
  terminal interativo na VM (xterm sobre o console serial).

**Sistema (42–48)**
- Checagem de atualização e de versão mínima do CLI; badge no tray; atalhos em
  prefs; temas customizados (importar/aplicar tokens em `:root`); zoom
  persistido; tela de diagnóstico com 11 checagens e log de crash.

**Qualidade (49, 50)**
- a11y: `role=tablist/tab` com `aria-selected`, `role=status` ao vivo, rótulos
  em todos os controles, `prefers-reduced-motion`, `.sr-only`.
- Telemetria opt-in (endpoint + flag) e crash log local; nada sai da máquina
  sem opt-in.

**Verificação**
- `npm run check`, `npm run lint`, `npm run build`.
- `probe/rpc-contract.mjs` 17/17 · `probe/review-contract.mjs` 15/15 ·
  `probe/insights-contract.mjs` 10/10.
- `probe/panels.mjs` 11/11 (abas, painéis, diagnóstico, voz) e
  `probe/a11y.mjs` 11/11 contra o app real via CDP.
- `probe/sandbox-e2e.mjs`: boot da VM, `apk add jq` pelo proxy, tarefa no guest
  (`uname` + `jq --version`), snapshot, diff, limites, agenda, allowlist e
  `TTY_OK` no terminal interativo.
- `probe/toolchain-e2e.mjs`: `jq` instalado, VM reiniciada, `jq` ainda presente.
- `probe/rewind-e2e.mjs`: dois checkpoints, rewind até o segundo reverte só o
  arquivo dele e poda o índice.
- `probe/review-e2e.mjs`, `probe/git-e2e.mjs`, `probe/system-e2e.mjs`: reverter
  e reaplicar patch, commit da sessão, worktree, blame, descartar untracked,
  zoom, tema aplicado/limpo, telemetria, crash log e diagnóstico 11/11.

## Plano v1 concluído (2026-11-11, 2ª passada)

- Aprovação de ferramentas: dialogs in-chat para confirm/input/select (fila
  `pendingDialog`), verificado e2e real — `rm -rf` → "Confirm dangerous command"
  → Recusar → resposta ao RPC.
- UI de MCPB/skills: lista instalados + instalação de pacotes no painel de settings.
- About window (menu do app) + buddy window (`noishi://buddy?cwd=…`, SessionHost
  próprio por janela, tray "Buddy window…", About no menu e no tray).
- GNOME search provider (ini + scripts em `build/search-provider/`, empacotado via
  `extraFiles`).
- aarch64: target AppImage arm64 + job `package-arm64` no CI.
- Cowork guiado: painel mostra prereq qemu ausente (com comando de instalação) e
  instrução de onde colocar os assets.

## Entregue (2026-11-14)

Os dois itens que estavam deferidos foram implementados:

1. **Extensão de navegador + native host**
   - Host: `apps/desktop/native-host/noishi-native-host.mjs` (frames uint32 LE +
     JSON, valida acao/tamanho, encaminha para socket Unix em
     `$XDG_RUNTIME_DIR/noishi/native.sock`, mode 0600). Wrapper `.sh` resolve o
     node em runtime.
   - Extensão MV3 em `apps/desktop/extension/`: action (pagina atual) e context
     menu (pagina / selecao), `key` fixa => ID deterministico
     `clbifamdddpbjofnkmdkiinepdbgbaec`. Erros aparecem como badge.
   - Instalar: `chrome://extensions` -> modo desenvolvedor -> "Carregar sem
     compactacao" apontando para `apps/desktop/extension` (ou o diretorio
     empacotado). O manifest do host e escrito pelo app no boot.
   - O app instala o manifest em Chrome/Chromium/Brave/Edge/Vivaldi no boot
     (`installNativeManifests`), reescrevendo `path` a cada execucao.
   - Share vira prompt no composer via rota `chat/share`.

2. **Terminal embutido**
   - `services/terminal.ts`: um PTY por janela (node-pty), criado com o cwd da
     sessao; dispose no fechamento da janela e no quit.
   - Canais `pty:*` no rpc-bridge + preload; `Terminal.tsx` com xterm.js +
     FitAddon e ResizeObserver; aba "Terminal" na topbar.
   - Terminal e o do usuario, separado do rpc `bash` do agente.

Ambos empacotados via `extraFiles` (`native-host`, `extension`).

## Fase 4 concluída — Sandbox (2026-11-14)

O painel "Cowork" virou **Sandbox** (aba ao lado de Chat/Terminal) e a VM passou a
entregar o que a Fase 4 pedia, não só bash com rede negada.

**Serviços**
- `services/sandbox-proxy.ts` — proxy de egress no host. O guest não tem rota para
  fora (`-netdev user,restrict=on`); o único caminho é `guestfwd` para este proxy,
  que aplica a allowlist por domínio (Alpine, npm, PyPI, crates.io, GitHub) e
  registra cada tentativa (liberada/negada) para a UI. Aceita CONNECT (HTTPS),
  absolute-URI e origin-form (fallback pelo header Host).
- `services/cowork-service.ts` — reescrito:
  - `virtiofsd` compartilha `~/noishi-cowork/workspace` no guest em `/workspace`
    (memfd + `vhost-user-fs-pci`); o que a tarefa escreve aparece no host.
  - Perfil `/etc/profile.d/sandbox.sh` no guest: proxy env, `PS1` fixo, cwd.
  - Repositório Alpine de rede adicionado ao `apk` (via proxy allowlistado).
  - `exec()` com exit code, timeout e strip de ANSI; `runTask()` com status
    (queued/running/done/failed) e evento `task` para a UI.
  - Artefatos: cada tarefa grava `~/noishi-cowork/artifacts/<id>/artifact.md`
    (status, comando, saída, arquivos do workspace) + `meta.json`; listagem e
    leitura por id.
- Canais novos no rpc-bridge: `sandboxBoot|Exec|Status|Task|Artifact|Allowlist|Shutdown`
  e `onSandboxEvent` (broadcast para todas as janelas).

**UI**
- Aba Sandbox: estado da VM (qemu/virtiofsd/assets), boot/desligar, barra
  `/workspace ← host` + contagem de egress, campo de comando com **Tarefa**
  (assíncrona, gera artefato) e **Exec** (síncrono), lista de tarefas com saída,
  lista de artefatos e visualizador com "Enviar ao chat".
- Janela de artefato (`noishi://cowork/shared-artifact?id=…`) lê o artefato real
  em vez de renderizar blocos da sessão.

**Verificado**
- `tsc --noEmit` limpo; `npm run build` ok; `probe/smoke.mjs` PASS.
- E2E real na VM: boot → `uname` → workspace montado (escrita visível nos dois
  lados) → `example.com` bloqueado (403 do proxy) → `dl-cdn.alpinelinux.org`
  liberado → `apk add nodejs` → `node -v` → tarefa `node test.js` → artefato
  criado e lido pela UI.
- E2E pela UI (CDP): aba Sandbox, boot, Exec e Tarefa com artefato listado e
  aberto no visualizador.

**Limites conhecidos**
- `npm` não vem no pacote `nodejs` do Alpine 3.21; instalar com `apk add npm`
  (ou usar `npx`/`corepack`) dentro da tarefa.
- O guest é efêmero: pacotes instalados somem no próximo boot, mas
  `sandboxProvision` grava `toolchain.txt` e o boot reaplica (custa o tempo do
  `apk`). Imagem com toolchain pré-instalada continua sendo a otimização
  natural.
- Allowlist é por domínio, sem MITM de TLS: o proxy tunela CONNECT e não inspeciona
  conteúdo. Inspeção (mitmproxy) fica para quando houver requisito de auditoria.
