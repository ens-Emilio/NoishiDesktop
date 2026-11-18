# Noishi Desktop — Code Review, Audit (Backend + UI/UX) e Plano de Correção

**Data:** 2026-11-17  
**Escopo:** Processo `main/` (`index.ts` + 27 serviços), `preload/`, `@noishi/rpc-bridge`, `renderer/` (`App.tsx` 2400 linhas, 6 painéis, CSS, workers, stores), `.github/workflows/ci.yml` e auditoria visual ao vivo via CDP (temas `dark`/`light`, 7 abas, 1200×800 e 760×640).

---

## 0. Estado Crítico de Integração (Diagnóstico Imediato)

Antes das vulnerabilidades e bugs pontuais, há **dois bloqueios estruturais** introduzidos ou deixados pelo commit `535f719`:

1. **Código órfão não conectado (0 importações):**
   - `apps/desktop/src/main/services/secrets.ts` (não usado por `prefs.ts` nem exposto via IPC)
   - `apps/desktop/src/main/services/process-supervisor.ts` (não usado por `session-host.ts`, `sandbox-vm.ts`, `terminal.ts` nem `main/index.ts`)
   - `apps/desktop/src/main/services/sandbox-drivers.ts` (stubs desconectados de `sandbox-vm.ts` / `cowork-service.ts`)
   - `apps/desktop/src/renderer/stores/panelStore.ts` e `createStore.ts` (não usados em `App.tsx`)
   - `apps/desktop/src/renderer/markdownWorkerClient.ts` e `workers/markdown.worker.ts` (não usados em `App.tsx`; e `DOMPurify` dentro de Web Worker não possui DOM)
   - `apps/desktop/src/renderer/ArtifactSandbox.tsx` (não usado em `App.tsx` nem em `artifact-window.ts`)
2. **Regressão no CI (`.github/workflows/ci.yml`):**
   - O commit `535f719` removeu os jobs de `build`, empacotamento `AppImage` (`x64` e `arm64`) e `smoke test` headless com `xvfb-run` (`probe/smoke.mjs`). Atualmente o CI roda apenas `check`, `lint` e 3 probes unitários de contrato.

---

## 1. Audit do Backend (Main, Preload, RPC, Sandbox, Git, CI)

### P0 — Críticos (Segurança e Perda de Dados/Controle)

- **[BE-P0-1] `openExternal` sem validação de esquema (`file://`, `smb://`, custom schemes)**  
  - **Onde:** `apps/desktop/src/main/services/desktop-commands.ts:244-247`  
  - **Problema:** `shell.openExternal(str(command.url))` repassa qualquer URL do renderer ao SO (`xdg-open`) sem checar protocolo. Um link malicioso ou XSS pode abrir binários/arquivos locais ou shares remotos.  
  - **Correção:** Permitir exclusivamente `http:` e `https:` após `new URL(url)` válido.

- **[BE-P0-2] Path Traversal em `applyPatch`, `revertFile`, `readArtifact`, `mcp-registry.removePackage` e `git.discard`**  
  - **Onde:**
    - `apps/desktop/src/main/services/review.ts:109-118` (`applyPatch` aceita `isAbsolute(path)` ou `join(cwd, path)` sem validar fronteira de `cwd`)
    - `apps/desktop/src/main/services/checkpoints.ts:95-110` (`revertFile` escreve/apaga `path` arbitrário)
    - `apps/desktop/src/main/services/sandbox-vm.ts:487-490` (`readArtifact(id)` usa `join(this.paths.artifacts, id, "artifact.md")` sem sanitizar `..`)
    - `apps/desktop/src/main/services/mcp-registry.ts:53-56, 156-168` (`removePackage(kind, name)` e `installPackage` fazem `rm(..., { recursive: true })` em `join(SKILLS_DIR, name)` sem rejeitar `/` ou `..`)
    - `apps/desktop/src/main/services/git.ts:112-124` (`discard` faz `rmSync(join(cwd, path))` sem checar contenção em `cwd`)
  - **Correção:** Criar helper compartilhado `assertWithin(baseDir, targetPath)` usando `realpathSync`/`resolve` + verificação de prefixo, e validar IDs/nomes com `/^[\w.-]+$/` sem `..`.

- **[BE-P0-3] Zip-Slip / Symlinks e race condition no `mcp-registry.ts`**  
  - **Onde:** `apps/desktop/src/main/services/mcp-registry.ts:31-34, 41-49`  
  - **Problema:** `agentDirSetup()` chama `void mkdir(...)` sem `await` (race condition na primeira instalação). `extractZip()` executa `unzip -o -q` direto no destino sem inspecionar entradas antes (`unzip -Z1`) contra symlinks que apontem para fora de `destDir` ou bombas de descompressão.  
  - **Correção:** `await mkdir(...)` em `agentDirSetup()`; listar/validar entradas do zip antes de extrair e rejeitar symlinks ou caminhos fora do diretório alvo.

- **[BE-P0-4] Symlink escape no snapshot/diff do Sandbox (`virtiofsd` + host `readFileSync`)**  
  - **Onde:** `apps/desktop/src/main/services/sandbox-vm.ts:510-612` (`workspaceDiff`, `createSnapshot`, `restoreSnapshot`)  
  - **Problema:** `statSync(full)` segue symlinks criados pelo guest dentro de `/workspace`. Um código não confiável na VM pode criar um symlink apontando para `~/.ssh/id_rsa` ou `/etc/shadow` do host; ao tirar snapshot ou calcular diff, o processo `main` lê o arquivo do host para dentro de `snapshots/`.  
  - **Correção:** Trocar `statSync` por `lstatSync` e ignorar (`if (info.isSymbolicLink()) continue;`) todos os symlinks durante walk/snapshot/restore.

- **[BE-P0-5] `app.quit()` bloqueado quando o Tray (SNI) está ativo**  
  - **Onde:** `apps/desktop/src/main/index.ts:124-128, 465-472`  
  - **Problema:** `win.on("close")` chama `event.preventDefault(); win.hide();` sempre que `minimizeToTrayEnabled()` é `true`, sem checar uma flag `isQuitting`. Clicar em "Sair" no menu do tray ou `Ctrl+Q` dispara `before-quit` → tenta fechar a janela → é cancelado pelo `close` listener → o app nunca fecha (observado na prática ao tentar encerrar com `SIGTERM` na auditoria).  
  - **Correção:** Definir `let isQuitting = false`, setar `isQuitting = true` em `before-quit`, e dar early return em `win.on("close")` quando `isQuitting === true`.

---

### P1 — Altos (Ciclo de Vida, Isolamento, Concorrência e Confiabilidade)

- **[BE-P1-1] Shutdown assíncrono não aguardado e processos órfãos**  
  - **Onde:** `apps/desktop/src/main/index.ts:465-472`, `session-host.ts:208-213`, `sandbox-vm.ts:660-678`  
  - **Problema:** `before-quit` chama `void cowork.shutdown()` e `sessionHost?.disposeAll()` (`void client?.stop()`) sem `event.preventDefault()`, então o Node encerra antes de QEMU, `virtiofsd`, `proxy` e `noushi rpc` terminarem. `process-supervisor.ts` não está conectado em lugar nenhum.  
  - **Correção:** Integrar `process-supervisor.ts` (`detached: true` + `trackProcess`) em `ThinRpcClient`, `SandboxVm` e `terminal.ts`, e no `before-quit` fazer teardown transacional com `event.preventDefault()` → `await` com timeout → `app.exit(0)`.

- **[BE-P1-2] `buddy-window.ts` cria janela invisível (`show: false` sem `win.show()`)**  
  - **Onde:** `apps/desktop/src/main/services/buddy-window.ts:28-40`  
  - **Problema:** O `BrowserWindow` é criado com `show: false`, mas nunca registra `win.once("ready-to-show", () => win.show())`. Abrir uma janela Buddy não exibe nada na tela.  
  - **Correção:** Adicionar `win.once("ready-to-show", () => win.show())`.

- **[BE-P1-3] Concorrência e corrupção na porta serial única da VM (`sandbox-vm.ts`)**  
  - **Onde:** `apps/desktop/src/main/services/sandbox-vm.ts:286-350`  
  - **Problema:** `execRaw()` abre uma nova conexão socket a cada chamada sem mutex/fila, e `openTty()` faz polling com `setInterval(..., 40)` drenando o mesmo socket serial. Chamadas simultâneas (`runTask` + `exec` + `SandboxTerminal`) roubam bytes umas das outras e corrompem marcadores `D...X_START`/`_END`. Além disso, em timeout, `execRaw` retorna `""` sem matar o comando no guest.  
  - **Correção:** Serializar `execRaw` via fila/mutex por VM (ou usar virtio-serial separado para `exec` vs `tty` interativo) e enviar `Ctrl+C`/kill no timeout.

- **[BE-P1-4] Vazamento de processos no `boot()` da VM em caso de falha**  
  - **Onde:** `apps/desktop/src/main/services/sandbox-vm.ts:138-216`  
  - **Problema:** Se `virtiofsd` ou `qemu` ou `prepareGuest()` falhar após `startSandboxProxy()`, o proxy e `virtiofsd` já iniciados não são fechados.  
  - **Correção:** Envolver `boot()` em `try/catch` chamando `await this.cleanupProcesses()` no erro.

- **[BE-P1-5] Sockets do sandbox em `/tmp` previsível (`cowork-service.ts`)**  
  - **Onde:** `apps/desktop/src/main/services/cowork-service.ts:61-62`  
  - **Problema:** `serialSock` e `virtiofsSock` são criados direto em `/tmp/noishi-sandbox-${id}-*.sock` (diretório compartilhado) em vez de `XDG_RUNTIME_DIR/noishi/` (`0o700`).  
  - **Correção:** Mover sockets para `join(process.env.XDG_RUNTIME_DIR || ..., "noishi")`.

- **[BE-P1-6] Falhas no `sandbox-proxy.ts`: `head.rest` perdido no `CONNECT`, portas livres e falta de timeout**  
  - **Onde:** `apps/desktop/src/main/services/sandbox-proxy.ts:88-165`  
  - **Problema:**
    1. Em requisições `CONNECT`, se o TLS ClientHello chegar junto com o header (`head.rest`), ele só é escrito no ramo `else`, sendo descartado no `CONNECT`.
    2. `resolveTarget` aceita qualquer porta (`github.com:22`, portas internas) e IPs literais não filtrados.
    3. `readHead` não tem idle timeout e `setAllowlist` não sanitiza strings vazias ou prefixos `*.`.
  - **Correção:** Escrever `head.rest` após `200 Connection Established`; restringir portas padrão (80/443 ou configuráveis), rejeitar strings vazias/IPs privados na allowlist e adicionar timeout no `readHead`.

- **[BE-P1-7] Bugs em `git.ts`: `status --porcelain=v1` sem `-z`, injeção de flags em `addWorktree`**  
  - **Onde:** `apps/desktop/src/main/services/git.ts:46-60, 160-165`  
  - **Problema:** `status --porcelain=v1` sem `-z` quebra nomes com espaços/aspas e renames (`R a -> b`). Em `addWorktree`, `branch` que comece com `-` pode ser interpretado como flag pelo `git worktree add`.  
  - **Correção:** Usar `--porcelain=v1 -z` com parser NUL-delimited; validar nomes de branch (ex.: `git check-ref-format --branch` ou bloquear prefixo `-`).

- **[BE-P1-8] Bug de flags em `voice.ts` quando `NOISHI_WHISPER_MODEL` não está definido**  
  - **Onde:** `apps/desktop/src/main/services/voice.ts:69`  
  - **Problema:** `["-m", process.env.NOISHI_WHISPER_MODEL ?? "", "-f", wav, ...].filter(Boolean)` remove a string vazia, resultando em `["-m", "-f", wav]` — o `whisper-cli` interpreta `-f` como caminho do modelo!  
  - **Correção:** Só incluir `["-m", model]` se `model` for não-vazio.

- **[BE-P1-9] Registro duplicado do atalho global e falta de `will-navigate` / `setWindowOpenHandler`**  
  - **Onde:** `apps/desktop/src/main/index.ts:81-131, 410, 426`  
  - **Problema:** `registerQuickWindow(toggleQuickWindow)` é chamado duas vezes no boot (linhas 410 e 426, confirmado no log da auditoria). Nenhuma `BrowserWindow` bloqueia `will-navigate` ou `setWindowOpenHandler` para impedir navegação acidental de links Markdown dentro do app.  
  - **Correção:** Remover chamada duplicada na linha 426 e configurar `webContents.on("will-navigate", ...)` + `setWindowOpenHandler(() => ({ action: "deny" }))` em todas as janelas.

---

### P2 — Médios (Performance, Framing RPC, Tipagem e Portabilidade)

- **[BE-P2-1] Framing UTF-8 e complexidade O(N²) no `ThinRpcClient`**  
  - **Onde:** `apps/desktop/src/main/services/thin-rpc-client.ts:81-90, 152-166`  
  - **Problema:** `chunk.toString("utf-8")` direto quebra caracteres multibyte divididos entre chunks (usar `StringDecoder("utf8")`). `stop()` usa `setTimeout` sem `clearTimeout` e não envia `SIGKILL` caso o filho ignore `SIGTERM`. Também falta evento de crash/EOF para recuperação na UI.  
  - **Correção:** Usar `StringDecoder`, `clearTimeout` no exit, escalonamento `SIGKILL` e emitir evento de `rpc_exit` para permitir reconexão.

- **[BE-P2-2] `workspace.ts` sem cache apesar do comentário, e `readTree` bloqueando UI**  
  - **Onde:** `apps/desktop/src/main/services/workspace.ts:5-7, 104-116`  
  - **Problema:** O comentário diz que árvores são cacheadas, mas `searchFiles` re-escaneia até 5000 arquivos do disco a cada tecla digitada no `@-mention`.  
  - **Correção:** Cache TTL curto (ex.: 5s) indexado por `root` em `workspace.ts`.

- **[BE-P2-3] `prefs.ts` com escrita debounced não flushada no quit & `session-host.ts` com provider/model hardcoded**  
  - **Onde:** `apps/desktop/src/main/services/prefs.ts:91-110`, `apps/desktop/src/main/services/session-host.ts:57-58`  
  - **Problema:** Alterações feitas nos últimos 120ms antes de fechar o app se perdem sem `flushPrefsSync()` no `before-quit`. `session-host.ts` passa `provider: "ghostcli", model: "claude-opus-5-5"` fixo no spawn.  
  - **Correção:** Exportar e chamar `flushPrefs()` no `before-quit`; ler provider/model default das prefs ou CLI config.

- **[BE-P2-4] `artifact-window.ts` ignora novo `artifactId` se janela já aberta & `tray.ts` usa `getAllWindows()[0]`**  
  - **Onde:** `apps/desktop/src/main/services/artifact-window.ts:13-16`, `apps/desktop/src/main/services/tray.ts:75, 101`  
  - **Problema:** Reabrir outro artifact apenas foca o antigo. O tray lê `getAllWindows()[0]` (pode ser Quick/About) e hardcoda `"CommandOrControl+Shift+Space"` no label.  
  - **Correção:** Recarregar URL/query em `showArtifactWindow(newId)` e passar callback `toggleMain` explícito para `createTray`.

- **[BE-P2-5] `desktopCommand` perde tipagem do union `SessionCommand` e falta `auto-update` / drivers reais**  
  - **Onde:** `apps/desktop/src/main/index.ts:282`, `apps/desktop/src/main/services/desktop-commands.ts:59`  
  - **Problema:** `command as unknown as Record<string, unknown>` contorna a checagem de tipos do `tsc`. `sandbox-drivers.ts` tem apenas stubs que dão `throw`, e `electron-updater` ainda não está configurado em `package.json`/`system.ts`.

---

## 2. Audit de UI/UX (Código + Auditoria Visual ao Vivo)

### Evidências Visuais Coletadas
Capturas e JSONs gerados com configuração isolada em `scratch/ui-audit/` (16 PNGs + `live-report.json` + `app-logs.txt`):
- `dark-Chat.png`, `dark-Terminal.png`, `dark-Sandbox.png`, `dark-Revisao.png`, `dark-Git.png`, `dark-Contexto.png`, `dark-Ajustes.png`, `dark-popover.png`
- `light-Chat.png`, `light-Terminal.png`, `light-Sandbox.png`, `light-Revisao.png`, `light-Git.png`, `light-Contexto.png`, `light-Ajustes.png`
- `narrow-760-chat.png`

---

### P0 — Críticos de UI/UX (Superfícies Quebradas ou Bloqueantes)

- **[UI-P0-1] 6 funcionalidades chamam `window.prompt()`, que lança erro e NÃO funciona no Electron**  
  - **Onde:** `SettingsPanel.tsx:128`, `ContextPanel.tsx:87`, `App.tsx:456, 476, 496, 515`  
  - **Problema:** No Electron (`contextIsolation` / Chromium), `window.prompt()` é desabilitado e falha ao clicar em: *Importar tema…*, *Mover para projeto…*, *+ VM*, *Instalar toolchain…*, *Snapshot* e *Agendar*.  
  - **Correção:** Substituir os 6 chamados pelo sistema de diálogo modal in-app (`pendingDialog` ou componente modal dedicado com React ref).

- **[UI-P0-2] Composer de Chat aparece fixo no rodapé de TODAS as 7 abas**  
  - **Onde:** `apps/desktop/src/renderer/App.tsx:2082-2390`  
  - **Evidência visual:** `dark-Terminal.png`, `dark-Ajustes.png`, `dark-Git.png`, `dark-Contexto.png`, `dark-Sandbox.png`, `light-Ajustes.png`  
  - **Problema:** O `.composer-wrap` (122px de altura) está fora da condição `view === "chat"`, roubando espaço vertical útil em Terminal, Ajustes, Revisão, Git, Contexto e Sandbox, e confundindo o usuário sobre para onde o prompt será enviado.  
  - **Correção:** Renderizar `.composer-wrap` somente quando `view === "chat"` (ou em `mode === "buddy"`).

- **[UI-P0-3] Aba `Terminal` completamente ilegível (texto invisível) no Tema Claro + Scrollbar branca**  
  - **Onde:** `apps/desktop/src/renderer/Terminal.tsx:24-38`, `SandboxTerminal.tsx:24-37`, `styles/screens.css:1735`  
  - **Evidência visual:** `light-Terminal.png` (tela inteira branca/lavanda sem nenhum texto visível) e `dark-Terminal.png` (barra de rolagem nativa branca contrastando com fundo escuro).  
  - **Problema:** `screens.css:1735` força `.terminal-host .xterm-viewport { background: transparent !important; }`, fazendo o fundo claro `--bg-window` (`#faf8fc`) aparecer atrás da fonte clara `#f3f0f7` do `xterm`.  
  - **Correção:** Sincronizar o `theme` do `XTerm` com `data-theme` (`dark` vs `light`) observando mudanças de tema, ou remover `background: transparent !important` mantendo fundo escuro consistente com scrollbar customizada.

- **[UI-P0-4] Em largura estreita (`720px–900px`), os botões de Minimizar/Maximizar/Fechar desaparecem fora da janela!**  
  - **Onde:** `apps/desktop/src/main/index.ts:85` (`minWidth: 720`), `App.tsx:1512-1622`, `screens.css:283-393`  
  - **Evidência visual:** `narrow-760-chat.png` (em 760px, `Ajustes`, `Clonar`, `Compactar`, `Exportar` e todos os `.window-controls` são cortados para fora da borda direita).  
  - **Problema:** Como a janela usa `frame: false` (sem moldura do SO), perder `.window-controls` em larguras próximas ao `minWidth: 720` impede o usuário de fechar, minimizar ou maximizar a janela pelo mouse!  
  - **Correção:** Fixar `.window-controls` à direita com `flex-shrink: 0`, tornar `.view-tabs` rolável ou compacto em telas estreitas, e ocultar/agrupar `.topbar-actions` secundárias em menu `⋯` abaixo de ~960px.

- **[UI-P0-5] Erro fatal de CLI/RPC invisível no estado inicial ("Noishi está pronto." + "conectando…" eterno)**  
  - **Onde:** `apps/desktop/src/renderer/App.tsx:1170-1176, 1858-1883`  
  - **Evidência visual:** `dark-Chat.png` + `app-logs.txt` (`getState noishi JS entry not found`).  
  - **Problema:** Quando `blocks.length === 0`, o banner `rpcError` não é renderizado (fica dentro do ramo `blocks.length > 0`). Além disso, `if (!state)` vem antes de `if (rpcError)` no cálculo de `status`, mantendo o texto `"conectando…"` mesmo após falha definitiva.  
  - **Correção:** Priorizar `if (rpcError)` em `status`, renderizar o banner de erro acima do greeting quando `blocks.length === 0`, e oferecer ação de retry / configurar caminho do CLI.

---

### P1 — Altos de UI/UX (Fluxos Quebrados, Performance de Streaming e A11y)

- **[UI-P1-1] Botão "Aplicar" do `ReviewPanel` entra em conflito com o próprio fluxo de `sessionDiff`**  
  - **Onde:** `apps/desktop/src/renderer/ReviewPanel.tsx:102-109`, `apps/desktop/src/main/services/review.ts:109-119, 166-207`  
  - **Problema:** `sessionDiff` gera um patch comparando o snapshot pré-edição com o arquivo atual no disco (`after`). Ou seja, o arquivo já está modificado no disco; clicar em "Aplicar" tenta reaplicar o patch sobre `after` e falha com `"contexto não confere"`.  
  - **Correção:** No modelo onde o agente já aplicou em disco, a revisão deve oferecer *"Manter / Marcar revisado"* e *"Reverter (Rejeitar)"*, ou manter patches pendentes em staging separado.

- **[UI-P1-2] Anexos de imagem são "vaporware" e botão "Editar mensagem" do assistente não faz nada**  
  - **Onde:** `App.tsx:300, 779-797, 2207-2224` (anexos) e `App.tsx:1915-1922, 1980-1995` (editar)  
  - **Problema:** Colar/arrastar imagem mostra chip visual, mas `sendPrompt` não envia nem limpa `attachments`. Clicar no ícone de lápis em uma resposta abre o modal `local-${block.id}`, mas `answer()` ignora esse prefixo ao clicar "Salvar e reenviar".

- **[UI-P1-3] Aba `Terminal` mata e reinicia o shell toda vez que o usuário troca de aba**  
  - **Onde:** `apps/desktop/src/renderer/Terminal.tsx:49` e `apps/desktop/src/main/services/terminal.ts:30`  
  - **Problema:** Ao voltar para a aba `Terminal`, `TerminalView` remonta e chama `pty.create()`, que no backend executa `disposeTerminal(windowId)` — destruindo o shell anterior em vez de reconectar ao PTY vivo.

- **[UI-P1-4] Árvore de arquivos multi-root sobrescreve todas as raízes com um único estado `tree`**  
  - **Onde:** `apps/desktop/src/renderer/App.tsx:305, 890-893, 1400-1416`  
  - **Problema:** `const [tree, setTree] = useState<FileNode[]>([])` é compartilhado entre todas as pastas em `roots`. Expandir a segunda raiz substitui os arquivos exibidos na primeira.

- **[UI-P1-5] Bottleneck de Streaming, Auto-scroll agressivo e Zero Virtualização**  
  - **Onde:** `apps/desktop/src/renderer/App.tsx:682-727, 1098-1101, 1884-1970`  
  - **Problema:**
    1. A cada `text_delta`, todo o componente `App` (2400 linhas) re-renderiza e executa `renderMarkdown` síncrono (marked + `highlightAuto` + DOMPurify) em **todas** as mensagens do chat.
    2. `el.scrollTop = el.scrollHeight` roda em todo `blocks` update, impedindo o usuário de rolar para cima durante uma resposta longa.
    3. Não há `React.memo` nos blocos nem virtualização de lista.
  - **Correção:** Conectar `panelStore` / `chatStore` segmentado, usar `React.memo` por bloco, cachear HTML renderizado das mensagens finalizadas, só fazer auto-scroll se o usuário já estiver próximo do fundo (`scrollHeight - scrollTop - clientHeight < 80`), e mover highlighting pesado para Web Worker usando uma sanitização segura (ou DOMPurify na main thread pós-highlight do worker).

- **[UI-P1-6] Ações destrutivas sem confirmação (`GitPanel.Descartar` e `ReviewPanel.Rejeitar`)**  
  - **Onde:** `GitPanel.tsx:152`, `ReviewPanel.tsx:181`  
  - **Problema:** Clicar em "Descartar" executa `rmSync` (arquivos novos) ou `git checkout --` imediatamente sem confirmação nem desfazer.

- **[UI-P1-7] Acessibilidade (a11y) e Contraste no Tema Escuro/Claro**  
  - **Onde:**
    - `App.tsx:2377` (`composer-send` ainda sem `aria-label`, só `title`)
    - `App.tsx:1585, 1588, 1592` (`findbar` prev/next/close sem `aria-label`)
    - `App.tsx:1911, 1915, 2145, 2156, 2213, 2231, 2338, 1779` (botões só-ícone sem `aria-label`)
    - `App.tsx:2000-2078` (`.dialog-layer` sem `role="dialog"`, `aria-modal="true"`, sem trap de foco e sem fechar com `Escape`; usa `document.querySelector`)
    - `live-report.json` (`dark-Ajustes`): `<input type="checkbox">` ou input nativo herdou `fg: rgb(0, 0, 0)` sobre `bg: rgb(33, 30, 41)` (**ratio 1.28:1** — falha WCAG AA).

---

### P2 — Médios de UI/UX (Polimento Visual, Layout e Consistência)

- **[UI-P2-1] Colisão visual `"Arquivos0"` na Sidebar + Versão exibida como `v0.0`**  
  - **Evidência visual:** `dark-Chat.png`, `light-Chat.png`  
  - **Problema:** Na sidebar, `Arquivos` e o contador `0` ficam colados sem espaço (`Arquivos0`) porque `.sidebar-section` usa `justify-content: space-between` com 3 filhos (`span`, `.count`, botão `+`). Além disso, `env.appVersion` aparece como `v0.0` em dev (`Electron` sem package metadata resolvida corretamente).

- **[UI-P2-2] `.status` truncado em 1200px (`● conec` / `● con`) e `.findbar` dentro de `<header className="topbar">`**  
  - **Evidência visual:** `dark-Terminal.png`, `dark-Ajustes.png`, e `App.tsx:1556-1605`  
  - **Problema:** A barra superior tenta acomodar breadcrumb + status + 7 abas + 3 botões de ação + 3 controles de janela em 46px. Pior: `.findbar` (`Ctrl+F`) é renderizada *dentro* do container flex `.topbar` em vez de logo abaixo dele.

- **[UI-P2-3] Layout comprimido em `Ajustes` e `Sandbox` + `SettingsPanel` disparando IPC por tecla**  
  - **Evidência visual:** `dark-Ajustes.png`, `dark-Sandbox.png`  
  - **Problema:** Labels `RAM (MB)` e `Timeout (s)` quebram em 2 linhas; `sandboxSetLimits`, `setShortcuts` e `setTelemetry` disparam IPC a cada digitação sem debounce e sem atualizar estado local. No `Sandbox`, caminhos longos em `sandbox-head` empurram os controles.

- **[UI-P2-4] Popovers secundários não fecham com clique fora / `Escape`, e altura do composer não persiste**  
  - **Onde:** `App.tsx:1103-1111, 2169-2206, 2293-2307, 2323`  
  - **Problema:** Apenas `popoverOpen` fecha no `mousedown` fora; `savedOpen` e `mentionOpen` ficam abertos. O resize do composer não chama `setPrefs({ composerHeight })`.

- **[UI-P2-5] Mistura de estilos e código morto de CSS / Falta de "Copiar código" em blocos Markdown**  
  - **Onde:** `markdown.ts:22`, `App.tsx` + `styles/cds.css` vs `screens.css`  
  - **Problema:** Blocos de código renderizam `<span class="md-lang">`, mas não há botão para copiar o trecho de código; bundle renderer único tem `1,266.39 kB` sem `React.lazy`.

---

## 3. Decomposição Proposta para `apps/desktop/src/renderer/App.tsx` (2400 linhas)

| Novo arquivo / módulo | Responsabilidade |
|---|---|
| `stores/sessionStore.ts` | Estado da sessão (`state`, `blocks`, `usage`, `queued`, `rpcError`, `needsInput`, streaming handlers) |
| `stores/workspaceStore.ts` | `roots`, `treeByRoot` (Map por raiz), `sessions`, `folders`, `sessionHits` |
| `stores/uiStore.ts` | `view`, `sidebarOpen`, `popoverOpen`, `findOpen`, `pendingDialog`, `prefs` |
| `components/Sidebar.tsx` | Brand, ações de projeto, árvore multi-root isolada, busca e lista de sessões |
| `components/Topbar.tsx` | Breadcrumb, status compacto, abas, ações e `.window-controls` fixos + `.findbar` abaixo |
| `components/ChatView.tsx` | Greeting, banners (incluindo erro CLI no empty state), lista memoizada de mensagens, scroll inteligente |
| `components/Composer.tsx` | Textarea redimensionável (com persistência), slash menu, `@-mention`, anexos, voz, popover de modelo/extensões |
| `components/SandboxView.tsx` | Painel de VMs, tarefas, snapshots, egress e `SandboxTerminal` |
| `components/DialogLayer.tsx` | Modal acessível (`role="dialog"`, focus trap, `Escape`, ref em vez de `querySelector`) |
| `components/QuickWindow.tsx` & `ArtifactView.tsx` | Superfícies `quick` e `artifact` integradas ao `ArtifactSandbox.tsx` |

---

## 4. Plano de Execução por Ondas

### Onda 0 — Correções Críticas Imediatas e Limpeza (1–2 dias)
1. Corrigir `win.on("close")` com flag `isQuitting` para `app.quit()` funcionar com Tray ativo (`main/index.ts`).
2. Validar esquema `http:`/`https:` em `openExternal` (`desktop-commands.ts`) e contenção de caminho (`assertWithin`) em `review.ts`, `checkpoints.ts`, `git.ts`, `sandbox-vm.ts` e `mcp-registry.ts`.
3. Corrigir `buddy-window.ts` (`ready-to-show` → `win.show()`), remover chamada duplicada `registerQuickWindow` (`main/index.ts:426`), corrigir `voice.ts` (`-m` sem modelo), e bloquear `will-navigate`/`setWindowOpenHandler`.
4. Restaurar jobs de `build`, `AppImage` (`x64`/`arm64`) e `smoke` (`xvfb-run`) em `.github/workflows/ci.yml`.

### Onda 1 — UI/UX Crítica & Visual Fixes (2–3 dias)
1. Mover `.composer-wrap` para renderizar apenas na aba `Chat` (e `buddy`), e mover `.findbar` para fora/abaixo de `.topbar`.
2. Corrigir `.terminal-host` no tema claro (`Terminal.tsx` / `SandboxTerminal.tsx` / `screens.css`) e customizar scrollbar do `xterm`.
3. Garantir visibilidade permanente de `.window-controls` em `720px+` (responsividade da `.topbar`).
4. Mostrar `rpcError` no empty state (`blocks.length === 0`) e corrigir ordem de prioridade em `status`.
5. Substituir os 6 `window.prompt()` por `DialogLayer` modal; corrigir botão Editar assistente e envio/limpeza de `attachments`; corrigir `"Arquivos0"` e `v0.0`.
6. Corrigir fluxo de `TerminalView` para não matar o PTY ao trocar de aba, e `ReviewPanel` ("Aplicar" vs "Manter/Reverter") + confirmação em ações destrutivas (`Descartar`, `Rejeitar`).

### Onda 2 — Integração dos Módulos Criados & Arquitetura Renderer (3–4 dias)
1. Fatiar `App.tsx` conforme a tabela da Seção 3 usando `stores/` baseados em `createStore.ts`, removendo re-renders globais no streaming.
2. Mover highlight pesado (`highlight.js`) para `markdown.worker.ts` mantendo `DOMPurify` na main thread (onde há DOM), adicionar cache de HTML renderizado + botão "Copiar código" + auto-scroll condicional.
3. Aplicar `React.lazy` em `TerminalView`, `SandboxTerminal`, `ReviewPanel`, `GitPanel`, `ContextPanel`, `SettingsPanel` e `ArtifactSandbox` para quebrar o bundle de 1.27 MB.
4. Integrar `ArtifactSandbox.tsx` na rota `mode === "artifact"` (`artifact-window.ts` passando novo `id`), conectando revisões de `checkpoints.ts` e ação *"Corrigir erro com Noishi"*.

### Onda 3 — Resiliência de Backend, Sandbox & Segurança de Credenciais (3–4 dias)
1. Conectar `process-supervisor.ts` a `ThinRpcClient`, `SandboxVm`, `terminal.ts` e `before-quit` transacional (`event.preventDefault()`).
2. Adicionar `StringDecoder`, `rpc_exit` event e reconexão/crash recovery no `ThinRpcClient` + `SessionHost`.
3. Corrigir `sandbox-vm.ts` (`lstatSync` contra symlinks no host, mutex na porta serial, cleanup no `boot()` em erro) e `cowork-service.ts` (sockets em `XDG_RUNTIME_DIR`).
4. Corrigir `sandbox-proxy.ts` (`head.rest` no `CONNECT`, filtro de portas, sanitização da allowlist, timeouts).
5. Conectar `secrets.ts` (`safeStorage`) a `prefs.ts` e expor gerenciamento seguro de tokens/MCP na aba `Ajustes`, além de `flushPrefs()` no quit.
6. Corrigir `git.ts` (`--porcelain=v1 -z`, proteção contra `-` em branch) e adicionar cache TTL em `workspace.ts`.

### Onda 4 — A11y, Acabamento de Design System & Distribuição (2–3 dias)
1. Zerar falhas de a11y/contraste: `aria-label` em todos os botões de ícone, `role="dialog"` + focus trap + `Escape`, corrigir input `ratio 1.28` no tema escuro e adicionar verificação automatizada no `probe/a11y.mjs` e `probe/audit-shots.mjs`.
2. Pré-aquecer janela `Quick` (`hide()` no close) para abertura instantânea em `Ctrl+Shift+Space`.
3. Conectar drivers reais (ou esconder seletores não suportados por SO) em `sandbox-drivers.ts` e finalizar `electron-updater` em `package.json` / `system.ts`.

---

## 5. Pontos Positivos (Preservar)
- Isolamento base das `BrowserWindow`s: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` em todas as janelas, e `pdf.ts` offscreen com `javascript: false`.
- `preload/index.ts` enxuto e totalmente roteado por `CHANNELS` tipados sem expor `ipcRenderer` genérico.
- Sanitização com `DOMPurify` no `markdown.ts` e CSP restritiva no `index.html`.
- `SandboxProxy` escutando apenas em `127.0.0.1` combinado com `-netdev user,restrict=on,guestfwd=...` no QEMU.
- Uso consistente de `execFile` (sem `shell: true`) em `git.ts`, `voice.ts`, `mcp-registry.ts` e `workspace.ts`.
- Suíte `probe/` bem estruturada cobrindo contratos RPC, review e insights.
