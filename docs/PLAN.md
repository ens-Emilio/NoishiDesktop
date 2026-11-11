# Noushi Desktop — Plano de Criação

Data: 2026-11-10 · Repo: `~/AgentCoding/NoushiDesktop` (vazio, só .git)
Decisões: shell Electron próprio (estilo Claude Desktop) · motor = SDK/RPC do NoushiCLI (pi 1.5.0) · escala = paridade com Claude Desktop

---

## 1. Arquitetura

```
┌──────────────────────────── Noushi Desktop (Electron) ────────────────────────────┐
│  main process (TS, electron-vite)                                                  │
│  ├─ windowManager      main / buddy / quick / about / find-in-page                 │
│  ├─ ipcRouter          contextBridge seguro, canais tipados                        │
│  ├─ sessionService     1 RpcClient do pi por sessão (spawn binário noushi --mode rpc)
│  ├─ deepLink           noushi:// protocol handler (code/new, code/continue, chat)  │
│  ├─ trayService        tray + menu (dark/light)                                    │
│  ├─ coworkService      VM QEMU (qemu-system-x86 + OVMF + virtiofsd + vhost-vsock)  │
│  ├─ mcpRegistry        instalação/execução de .mcpb e .skill (zip)                 │
│  └─ nativeHost         chrome-native-messaging host p/ extensão de navegador       │
│                                                                                    │
│  renderer (React + Vite, TypeScript)                                               │
│  ├─ chatView          conversas com o agente (streaming de eventos RPC)            │
│  ├─ sessionsView      sessões Code: criar/retomar/fork/clone, diff de arquivos     │
│  ├─ coworkView        tarefas em VM sandbox, progresso, artefatos                  │
│  └─ settingsView      modelos, thinking level, custo, permissões                   │
│                                                                                    │
│  agentes utilitários (child processes, como o upstream)                            │
│  ├─ ptyHost           node-pty para terminais embutidos                            │
│  └─ mcpHost           runtime MCP (stdio hosts)                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ RPC JSONL (stdin/stdout, já implementado no pi: rpc-mode + RpcClient)
        ▼
   NoushiCLI (binário `noushi`, repo NoushiCLI, pin earendil 676af1d, engine 1.5.0)
        ├─ ferramentas: read/write/edit/ast_edit/lsp/bash/process/sqlite/sandbox
        ├─ sessões: new/fork/clone/compact/export
        └─ MCP servers, skills, permissões, audit log (~/.noushi)
```

**Decisões-chave (e por quê):**

1. **Motor via RPC do pi, não re-implementação.** O pi já exporta `RpcClient` (`packages/coding-agent/src/modes/rpc/rpc-client.ts`) com prompt/steer/followUp/abort/fork/compact/bash/modelos/thinking/custo. O desktop vira um *shell* — a lógica de agente permanece no NoushiCLI. Zero duplicação de cérebro.
2. **Electron, não Tauri.** O pi é Node; `RpcClient` usa `child_process`/streams de Node. Electron roda o mesmo código no main sem polyfill. Tauri exigiria reescrever o transporte em Rust.
3. **UI própria, sem copiar assets da Anthropic.** O Claude Desktop extraído (`~/Downloads/claude-desktop/extracted/`) é *referência de features/comportamento* (routes, IPC surface, cowork), não código a reaproveitar — licença proprietária.
4. **Paridade por camadas.** Chat + Code primeiro (núcleo usável), Cowork/MCPB/skills depois (integrações de sistema).

---

## 2. O que herdamos do ecossistema Noushi (sem reescrever)

| Componente | Origem | Uso no Desktop |
|---|---|---|
| `RpcClient` + rpc-mode (JSONL) | NoushiCLI `packages/coding-agent` | transporte de cada sessão |
| Sessões fork/clone/compact | rpc commands `fork`, `clone`, `compact` | botões da sessionsView |
| Modelos/thinking/custo | rpc `getAvailableModels`, `setModel`, `setThinkingLevel`, `getSessionStats` | settingsView + status bar |
| Permissões/segurança | pi core (approval, sandbox bwrap, audit) | respeitados; desktop só renderiza pedidos (`extension` UI requests: confirm/select/input/notify/setStatus/setWidget) |
| Skills/MCP | pi core + `pi-mcp` | mcpRegistry só empacota/instala |
| Marca/config `.noushi` | `piConfig` | mesmo configDir, tema geométrico Noushi |

**Referências de features extraídas do Claude Desktop** (para guiar paridade, não para copiar código):
- rotas deep-link: `chat/new`, `code/new`, `code/continue`, `code/needs-input`, `cowork/shared-artifact`
- 7 janelas; tray dark/light; GNOME search provider; MIME `.mcpb`/`.dxt`/`.skill`; `chrome-native-host` p/ extensão
- Cowork = VM QEMU (OVMF, virtiofsd, vhost-vsock, imagem smol-bin 28MB, allowlist de domínios npm/pypi/crates/github/anthropic, mitm proxy p/ *.anthropic.com)

---

## 3. Estrutura do repo

```
NoushiDesktop/
├─ package.json              workspaces: apps/*, packages/*
├─ apps/
│  └─ desktop/               app Electron (electron-vite + electron-builder)
│     ├─ src/main/           main process (windowManager, ipcRouter, services/)
│     ├─ src/preload/        contextBridge tipado por janela
│     ├─ src/renderer/       React (chat, sessions, cowork, settings)
│     └─ resources/          ícones, tray, native-host manifest
├─ packages/
│  ├─ rpc-bridge/            tipagem compartilhada dos canais IPC + wrapper RpcClient
│  └─ noushi-sdk/            thin wrapper: resolve binário noushi (PATH, ~/.noushi/bin, bundled)
└─ docs/
   ├─ PLAN.md (este arquivo)
   └─ PARITY.md              checklist Claude Desktop → Noushi Desktop
```

Vínculo com o NoushiCLI: `packages/noushi-sdk` declara `@earendil-works/pi-coding-agent` como dep opcional de *desenvolvimento* (file: para o checkout irmão em `../NoushiCLI`), mas em produção o desktop **spawn o binário `noushi` instalado** — desacopla ciclos de build.

---

## 4. Fases

### Fase 0 — Fundação (meio dia)
- Scaffold do monorepo (npm workspaces, electron-vite, TypeScript strict, ESLint — seguir regras do AGENTS.md do NoushiCLI: sem `any`, sem dynamic imports, erasable TS).
- `noushi-sdk`: detectar binário `noushi` (env `NOUSHI_DESKTOP_CLI` → `~/.noushi/bin/noushi` → PATH), versão mínima, teste de `--version`.
- `rpc-bridge`: tipos dos comandos RPC do pi (prompt/steer/abort/fork/clone/compact/bash/models/thinking/stats) e eventos (`message_update`, `tool_execution`, `extension` UI requests).
- **Aceite:** `RpcClient` abre sessão no checkout do NoushiCLI, prompt de teste responde com stream de eventos.

### Fase 1 — Janela principal + chat (2–3 dias)
- windowManager: BrowserWindow main (frame com barra título própria, tema claro/escuro), About, teardown limpo.
- ipcRouter + preload: canais `session:*` (prompt/steer/abort/state/models/stats), tipados, sem expor Node ao renderer.
- chatView: lista de mensagens, streaming dos eventos do agente, renderização de markdown/código (highlight), pedidos de ferramenta com approve/deny (extension requests), cancelamento.
- **Aceite:** conversa multi-turno com ferramentas funcionando; custo/contexto visíveis (getSessionStats).

### Fase 2 — Sessões Code (2–3 dias)
- sessionsView: nova sessão (escolha de diretório), retomar (histórico de sessões do pi em `~/.noushi`), fork, clone, compact, export HTML.
- Diffs de arquivo como cards no chat (eventos de tool edit/write com diff).
- Terminal embutido opcional via rpc `bash` (PTY no main, xterm.js no renderer) — v2 se apertar.
- **Aceite:** ciclo completo: criar sessão num repo → pedir implementação → aprovar diffs → retomar depois de fechar o app.

### Fase 3 — Integração de sistema (2–3 dias)
- deep-link `noushi://` (protocol.registerSchemesAsPrivileged + single-instance lock; rotas: `chat/new`, `code/new?cwd=`, `code/continue`, `code/needs-input`).
- Tray (ícones dark/light, menu: nova conversa, nova sessão code, sair) + single-instance focus.
- Notificações nativas (needs-input / conclusão de tarefa em background).
- Multi-janela: buddy_window (conversa secundária por projeto) e quick_window (captura rápida global — atalho do SO).
- **Aceite:** `xdg-open "noushi://code/new?cwd=/tmp/x"` abre o app na sessão certa; tray reflete estado; Ícone/sessões sobrevivem a restart.

### Fase 4 — Cowork (VM sandbox) (1–2 semanas, o maior item)
- Detecção de prereqs (qemu-system-x86, edk2-ovmf, virtiofsd, vhost_vsock); UI de setup guiado quando faltar.
- coworkService: ciclo de vida da VM (qemu headless, virtiofs p/ workspace, vsock p/ canal host↔guest), espelhando o design do smol-bin (referência: `srt-settings.json` — allowlist de domínios, denyRead de `/run/systemd/resolve` e `/run/dbus`, mitm proxy p/ domínios do produto).
- Guest agent: o `sandbox-helper`/`sdk-daemon` são binários fechados da Anthropic — **implementação própria** em Rust (Koushi pode doar o executor sandbox) ou shell+systemd dentro de uma imagem cloud-init mínima.
- coworkView: criação de tarefa, progresso, artefatos, compartilhamento (`noushi://cowork/shared-artifact`).
- **Aceite:** tarefa "rode os testes deste repo num ambiente limpo" executa dentro da VM, rede restrita à allowlist, artefato volta ao chat.

### Fase 5 — Extensões (1 semana)
- mcpRegistry: instalar `.mcpb`/`.skill` (zip validado: manifest + payload), registrar no config do pi (`~/.noushi`), listar/ativar/desativar na settingsView.
- chrome-native-host: manifest de native messaging p/ extensão de navegador "compartilhar página com o Noushi" (equivalente do claude-for-chrome).
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
| RPC do pi evolui e quebra o bridge | médio | pin no revision do NoushiCLI; testes de contrato no rpc-bridge (fixtures de eventos) |
| Cowork: guest agent é trabalho novo (binários da Anthropic não reaproveitáveis) | alto | Fase 4 isolada; MVP do Cowork só bash na VM, sem daemon rico; alternativa: container (bwrap/docker) como modo "light" |
| contextBridge largo vira superfície de ataque | médio | canais mínimos por janela, validação de `cwd` no main, nunca `nodeIntegration`; seguir padrão do pi (sender validation) |
| Licença: referência vs. implementação | alto se copiado | regra dura: nenhum asset/código da Anthropic no repo; apenas *comportamento* reimplementado; audit no PR |
| Electron ≈ 200MB por instalação | baixo | aceitável (Claude Desktop tem 218MB só no binário) |

## 6. Métricas de sucesso v1
- App abre < 3s, sessão Code responde ao primeiro token < 2s (limitado pelo provider).
- Zero prompts de permissão duplicados entre desktop e pi (desktop só renderiza os pedidos do agente).
- Paridade v1: chat, sessões code com fork/compact, tray, deep-links, MCPB/skills. Cowork funcional mas marcado beta.
