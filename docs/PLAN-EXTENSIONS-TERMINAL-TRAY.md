# Plano — chrome-native-host, terminal embutido, tray Plasma6

Complementa `docs/PLAN.md` (§ Deferidos) e `docs/UI-PLAN.md`.
Estado verificado no repo: 2026-11-14.

---

## Correção aplicada antes deste plano

Renomear sessão usava `type: "set_title"`, que **não existe** no RPC do NoishiCLI
(`modes/rpc/rpc-types.d.ts` só define `set_session_name` com campo `name`). Corrigido
em `session-host.ts`. O botão nunca teria funcionado.

---

## 1. chrome-native-host

### Decisão de escopo (proposta, ajustável)

| Pergunta | Proposta | Por quê |
|---|---|---|
| Browsers | Chrome/Chromium primeiro; Firefox depois | O manifest e o diretório diferem (`NativeMessagingHosts` vs `native-messaging-hosts`); Chrome cobre o uso real |
| Ação | Enviar **URL + texto selecionado** para uma sessão nova | É o caso de uso que o design system já prevê ("compartilhar página com o Noishi"); screenshot fica fora da v1 |
| Distribuição | Side-load via instalador do app (o `.deb`/AppImage escreve o manifest) | Chrome Web Store exige conta, revisão e política de privacidade; side-load funciona hoje |
| Transporte | Native messaging (JSON no stdin/stdout) → app abre `noishi://code/new?cwd=…&prompt=…` | O scheme já está registrado; nenhum canal novo |

### Arquitetura

```
extensão (service worker)
  └─ chrome.runtime.sendNativeMessage("com.noishi.host", {url, text, title})
       ↕ stdin/stdout JSON, 1 msg por frame (uint32 LE length + payload)
binário nativo (Node, ~80 linhas)
  └─ valida origem permitida → xdg-open "noishi://code/new?cwd=<dir>&prompt=<url+texto>"
       ↕
Electron main (rota já existe)
```

### Arquivos

| Arquivo | Papel |
|---|---|
| `apps/desktop/src/native-host/index.ts` | Host: lê frames do stdin, valida `origin`, abre o deep link. ~80 linhas |
| `apps/desktop/src/native-host/manifest.json` | `allowed_origins: ["chrome-extension://<ID>/"]` + nome `com.noishi.host` |
| `apps/desktop/browser-extension/manifest.json` | MV3, `permissions: ["nativeMessaging","activeTab","contextMenus"]` |
| `apps/desktop/browser-extension/background.js` | Context menu "Enviar para o Noishi" + botão da action |
| `apps/desktop/electron.vite.config.ts` | entry adicional `native-host` → `out/native-host/index.js` |
| `apps/desktop/package.json` | `extraFiles` leva host + manifest para o pacote; `.desktop` ganha o MimeType |

### Instalação no sistema (feita pelo app, não pelo usuário)

No primeiro `app.whenReady()`, se o host não estiver registrado:
1. Copia `out/native-host/index.js` e o manifest para `~/.local/share/noishi/native-host/`.
2. Escreve `~/.config/google-chrome/NativeMessagingHosts/com.noishi.host.json` apontando
   para um wrapper shell (`node <path>/index.js`), porque o manifest exige caminho absoluto
   e o Node do Electron não é o do sistema.
3. `chmod +x` no wrapper.
4. Loga sucesso/falha; falha não bloqueia o app (o recurso só fica indisponível).

### Segurança

- `allowed_origins` restrito ao ID da extensão (o ID é fixado pela `key` no manifest da
  extensão, para não mudar entre builds).
- Host valida que o payload tem `{url, text?}` com tipos corretos antes de montar o link.
- URL de destino é percent-encoded; nenhum shell é invocado (spawn com args, não `exec`).
- Limite de 256 KB por mensagem (o Chrome limita a 1 MB; margem segura).

### Fases e aceite

| # | Passo | Aceite |
|---|---|---|
| 1.1 | Host + manifest + frames | `echo` de um frame JSON no stdin devolve resposta válida |
| 1.2 | Extensão MV3 mínima | Botão envia e o app abre a sessão com o prompt preenchido |
| 1.3 | Instalador do manifest no boot | Depois de `npm run package` e instalar o `.deb`, o Chrome vê `com.noishi.host` |
| 1.4 | Context menu + tratamento de erro | "Enviar para o Noishi" e, se o app estiver fechado, ele abre |

Estimativa: **3–4 dias** (1.1 e 1.2 são 2 dias; 1.3 e 1.4 o resto).

---

## 2. Terminal embutido

### Decisão de escopo (proposta, ajustável)

| Pergunta | Proposta | Por quê |
|---|---|---|
| Onde vive | Aba na main window, ao lado do chat | O plano original dizia "aba na main window vs painel do cowork"; aba é o menor diff e não polui o chat |
| Que shell | PTY independente (`node-pty`), **não** o rpc `bash` | O rpc `bash` injeta no contexto do agente e polui a conversa; o usuário quer um terminal para si |
| Escopo | Um terminal por sessão, cwd = diretório da sessão | Combina com o modelo mental de "sessão = projeto" |
| Persistência | Morre com a janela | Sem estado em disco na v1 |
| Segurança | Sem pré-aprovação de comando (é o seu terminal), mas sandbox fiscalizado quando `process.env.SANDBOX` pedir | O agente continua passando por aprovação; o terminal é do humano |

### Arquitetura

```
renderer  xterm.js (aba "Terminal")
   ↕ IPC: pty:write / pty:resize / pty:data (stream)
main      node-pty (spawn shell no cwd da sessão)
```

### Arquivos

| Arquivo | Papel |
|---|---|
| `apps/desktop/src/main/services/terminal.ts` | Um `IPty` por janela; `create/write/resize/dispose`; mata no `before-quit` |
| `apps/desktop/src/main/index.ts` | Canais `pty:create`, `pty:write`, `pty:resize`; stream `pty:data` por `sender.id` |
| `packages/rpc-bridge/src/index.ts` | Tipos dos canais (`PtyCreateCommand`, `PtyDataEvent`) |
| `apps/desktop/src/preload/index.ts` | `pty: { create, write, resize, onData }` |
| `apps/desktop/src/renderer/Terminal.tsx` | Componente xterm.js + FitAddon, monta/desmonta com a aba |
| `apps/desktop/src/renderer/App.tsx` | Aba "Terminal" na topbar; `view: "chat" \| "terminal"` |
| `apps/desktop/package.json` | `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` |

### Fases e aceite

| # | Passo | Aceite |
|---|---|---|
| 2.1 | `terminal.ts` + IPC + preload | `pty.create` no main spawna `$SHELL` e o output chega ao renderer |
| 2.2 | Componente xterm com fit e resize | Redimensionar a janela reflui as colunas; `vim` e `htop` funcionam |
| 2.3 | Aba na topbar + cwd da sessão | Trocar de aba preserva o PTY; `pwd` mostra o diretório da sessão |
| 2.4 | Ciclo de vida | Fechar a janela mata o PTY (sem processos órfãos); `before-quit` idem |

Estimativa: **2–3 dias**.

Riscos: `node-pty` é módulo nativo — precisa de `electron-rebuild` e o `npmRebuild: false`
do `electron-builder` atual passa a precisar de exceção; testar no CI do AppImage.

---

## 3. Tray no Plasma6

### Diagnóstico

Hoje o código engole a falha do `new Tray()` com log. O sintoma no Plasma 6 é o ícone
não aparecer na bandeja, sem exceção. Causas conhecidas em Electron 33:

1. Plasma 6 exige o protocolo **StatusNotifierItem**; Electron só registra SNI se
   `libappindicator`/`libayatana-appindicator` estiver presente em runtime.
2. O ícone precisa ser `NativeImage` de 22×22 (não 16) para o Plasma escalar corretamente.
3. O `setContextMenu` no Linux precisa ser reaplicado depois que o item é registrado.

### Fases

| # | Passo | Aceite |
|---|---|---|
| 3.1 | Detectar `libayatana-appindicator3` em runtime; log explícito (não silencioso) | Log diz "tray: SNI indisponível (instale libayatana-appindicator)" |
| 3.2 | Ícone 22×22 com `setTemplateImage(false)` e escala correta | Ícone nítido no Plasma e no GNOME |
| 3.3 | Reaplicar `setContextMenu` após 500 ms e no 2º `setToolTip` | Menu abre no Plasma 6 |
| 3.4 | Fallback real: se SNI falhar, oferecer `--minimize-to-tray=false` e documentar | App não fica sem tray silenciosamente |

Estimativa: **1 dia** (é diagnóstico + ajuste, não feature nova).
Risco: se o Plasma 6 da máquina não tiver o appindicator instalado, nenhum código resolve —
por isso o passo 3.4 (detecção honesta em vez de guard silencioso).

---

## Ordem recomendada

| Ordem | Item | Motivo |
|---|---|---|
| 1º | Tray (1 dia) | Mais barato, melhora o que já existe, sem dependência nova |
| 2º | Terminal (2–3 dias) | Alto valor diário, escopo técnico contido |
| 3º | Extensão (3–4 dias) | Maior superfície nova (host + extensão + distribuição) |

Total: **6–8 dias**.

## Verificação por fase

Todas seguem o mesmo padrão já usado no repo:
`npx tsc --noEmit` → `npm run build --workspace apps/desktop` → `node probe/smoke.mjs`
→ verificação por CDP do comportamento novo.
