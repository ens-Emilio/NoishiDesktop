# Contribuindo com o Noishi Desktop

Obrigado pelo interesse em contribuir! Este documento descreve como configurar o ambiente de desenvolvimento e enviar contribuições.

## Ambiente de Desenvolvimento

### Pré-requisitos

- Node.js 20+
- Docker ou Podman (necessário para o sandbox do agente)
- Linux (o build atual suporta AppImage e deb)

### Setup

```bash
git clone https://github.com/ens-Emilio/NoishiDesktop.git
cd NoishiDesktop
npm install
npm run dev
```

O comando `dev` inicia o Electron em modo de desenvolvimento com hot-reload no renderer.

## Estrutura do Projeto

```
apps/desktop/          # Aplicativo Electron
  src/main/            # Processo principal (Node.js)
  src/preload/         # Script de preload (bridge segura)
  src/renderer/        # Interface React
packages/
  noishi-sdk/          # SDK compartilhado
  rpc-bridge/          # Contratos IPC entre main e renderer
DOCS/                  # Documentação pública
```

## Convenções de Código

- TypeScript strict mode em todos os pacotes
- ESM (`"type": "module"`) em todo o projeto
- Commits em português ou inglês, formato convencional (`feat:`, `fix:`, `docs:`, etc.)
- Sem dependências desnecessárias: prefira stdlib e pacotes já instalados
- Testes manuais via probes em `probe/` antes de abrir PR

## Abrindo um Pull Request

1. Crie uma branch descritiva: `feat/memory-fallback`, `fix/reaper-timeout`
2. Garanta que `npm run check` passe sem erros
3. Descreva o que mudou e por quê no PR
4. Referencie issues relacionadas se houver

## Reportando Bugs

Abra uma issue com:

- Passos para reproduzir
- Comportamento esperado vs. observado
- Logs relevantes (Console do DevTools, terminal do main process)
- Versão do Node.js, Docker/Podman e sistema operacional

## Licença

Ao contribuir, você concorda que suas contribuições serão licenciadas sob a Apache License 2.0, mesma licença do projeto.