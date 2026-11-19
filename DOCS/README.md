# Noishi Desktop

Noishi Desktop é um shell Electron open source para agentes de codificação, alternativa livre ao Claude Desktop. Ele gerencia sessões de agente, terminais integrados e um runtime de inteligência local compatível com o protocolo AG-UI, usando containers Docker/Podman apenas para sandbox de execução isolada.

## Requisitos

- Node.js 20+
- Docker ou Podman (para o sandbox do agente)
- Linux (AppImage/deb)

## Instalação

```bash
npm install
npm run dev
```

Para build de produção:

```bash
npm run package
```

Os artefatos ficam em `apps/desktop/dist/`.

## Arquitetura

O projeto é um monorepo npm workspaces:

- `apps/desktop` — aplicativo Electron (main + renderer + preload)
- `packages/noishi-sdk` — SDK compartilhado para resolução de CLI e contratos
- `packages/rpc-bridge` — bridge IPC entre main e renderer

### Local Intelligence Runtime

O cérebro do Noishi roda como um daemon Node.js leve (~40MB RSS) com:

- **Persistência SQLite** (WAL mode) para threads, eventos, memórias e skills
- **Servidor HTTP/SSE** compatível com o protocolo AG-UI, com suporte a `Last-Event-ID` para replay idempotente
- **Memória híbrida**: busca vetorial (sqlite-vec) com fallback lexical (FTS5 BM25) quando o endpoint de embeddings está offline
- **Skill Miner**: detecta padrões em sessões com ≥3 tool calls e gera rascunhos de SKILL.md para aprovação manual
- **Reaper de container**: pausa o sandbox após 15min sem tool calls, libera CPU mantendo estado do browser

O sandbox (`agent-computer` + `supervisor`) roda em containers Docker/Podman separados, gerenciados pela classe `SandboxStack`.

## Configuração

O daemon de inteligência escuta em porta dinâmica (alocada pelo SO), comunicada ao processo principal via IPC. O sandbox usa as portas padrão:

| Serviço | Porta |
|---|---|
| agent-computer | 4100 |
| supervisor | 4500 |

O token de autenticação do computer é gerado automaticamente em `~/.noishi/openbot/secrets/computer_token`.

## Licença

Apache License 2.0 — veja [LICENSE](../LICENSE).