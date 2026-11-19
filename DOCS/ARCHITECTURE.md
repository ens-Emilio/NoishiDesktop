# Arquitetura do Noishi Desktop

## Visão Geral

Noishi Desktop é um shell Electron para agentes de codificação que combina:

1.  **Interface desktop nativa** com terminal integrado, file explorer e gerenciamento de sessões
2.  **Runtime de inteligência local** leve e offline-first, compatível com o protocolo AG-UI
3.  **Sandbox de execução isolada** via containers Docker/Podman para segurança do agente

## Componentes Principais

### Aplicativo Electron (`apps/desktop`)

-   **Main Process**: gerencia janelas, IPC, lifecycle do sandbox e do daemon de inteligência
-   **Preload**: bridge segura entre main e renderer via context isolation
-   **Renderer**: interface React com xterm.js para terminal, marked para markdown, highlight.js para syntax highlighting

### Local Intelligence Runtime (`apps/desktop/src/main/services/local-intelligence/`)

Daemon Node.js independente que roda como processo filho do main process:

| Módulo | Responsabilidade |
|---|---|
| `db.ts` | SQLite WAL + migrations idempotentes (threads, eventos, memórias, skills, audit) |
| `server.ts` | Hono HTTP server com SSE AG-UI, `Last-Event-ID`, endpoints de memória e skills |
| `daemon.ts` | Entrypoint do processo filho com idle timeout (15min) e graceful shutdown |
| `daemon-manager.ts` | Gerenciador no main process: lazy-start, porta dinâmica via IPC |
| `computer-bridge.ts` | Ponte HTTP para agent-computer com token auth e unpause transparente |
| `reaper.ts` | Monitora tool calls, pausa container após 15min idle via `docker pause` |
| `embeddings.ts` | Cliente OpenAI-compatible (Ollama/remoto), retorna null em falha |
| `embedding-backfill.ts` | Worker assíncrono que completa embeddings pendentes a cada 60s |
| `memory.ts` | Busca híbrida: sqlite-vec semântico + FTS5 BM25 lexical como fallback |
| `skill-miner.ts` | Detecta threads com ≥3 tool calls, gera SKILL.md em `~/.noishi/skills/pending/` |
| `audit.ts` | Registro append-only de todas as tool calls para compliance e debugging |

### Sandbox Stack (`apps/desktop/src/main/services/openbot-stack.ts`)

Classe `SandboxStack` gerencia apenas os containers de execução:

-   `agent-computer`: Chromium + workspace montado, porta 4100
-   `supervisor`: criação/reset de computadores isolados, porta 4500
-   Secrets gerados automaticamente em `~/.noishi/openbot/secrets/`
-   Integração com daemon-manager para lifecycle unificado

### Pacotes Compartilhados

-   `packages/noishi-sdk`: resolução de CLI do agente, contratos de versão
-   `packages/rpc-bridge`: tipos e canais IPC tipados entre main e renderer

## Fluxo de Dados

```
Usuário → Renderer → IPC → Main Process
                              ├─→ SandboxStack → Docker/Podman → agent-computer
                              └─→ DaemonManager → LocalIntelligenceDaemon
                                                    ├─→ SQLite (persistência)
                                                    ├─→ SSE → Renderer (streaming AG-UI)
                                                    └─→ ComputerBridge → agent-computer (tool calls)
```

## Portas e Endpoints

| Serviço | Porta | Protocolo |
|---|---|---|
| Intelligence Daemon | Dinâmica (:0) | HTTP/SSE (AG-UI) |
| agent-computer | 4100 | HTTP (token auth) |
| supervisor | 4500 | HTTP (interno) |

## Persistência

-   **Inteligência**: `~/.noishi/intelligence.db` (SQLite WAL)
-   **Skills**: `~/.noishi/skills/pending/` e `~/.noishi/skills/active/`
-   **Secrets**: `~/.noishi/openbot/secrets/`
-   **Compose**: `~/.noishi/openbot/docker-compose.yml`

## Dependências Chave

| Pacote | Uso |
|---|---|
| `better-sqlite3` | SQLite síncrono com WAL para zero race conditions |
| `hono` | HTTP server leve com zero deps transitivas |
| `@hono/node-server` | Adapter Hono → Node http.createServer |
| `electron` | Shell desktop |
| `node-pty` | Terminal PTY real no renderer |
| `xterm` | Emulador de terminal no renderer |