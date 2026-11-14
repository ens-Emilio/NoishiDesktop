# Noishi Desktop — Plano de UI (design system + protótipo)

Fonte: `noishi-design-system.html` (v1.0) e `noishi-prototipo.html`, ambos em
`~/.config/Claude-3p/local-agent-mode-sessions/3ee5c8f9/00000000/df984e80/outputs/`.

Estado atual: `apps/desktop/src/renderer/App.tsx` (861 linhas, CSS inline em template
string), paleta quente herdada do Claude (`#191919` / acento `#d97757`), uma família
tipográfica, sem tema claro, sem diff, sem fork por mensagem, sem modo compacto.

---

## 0. Correção de premissa (antes de tudo)

O design system desenha o card de tool com `patch.hunks`. **O RPC do NoishiCLI não
emite `patch`.** O que existe:

| Fonte real | Onde | Forma |
|---|---|---|
| `toolcall_start` | `assistantMessageEvent` | `{ id, toolName }` |
| `toolcall_delta` | idem | `{ delta }` — JSON parcial dos argumentos |
| `toolcall_end` | idem | fecha o bloco |
| tool `edit` | argumentos | `{ path, edits: [{ oldText, newText }] }` |
| tool `write` | argumentos | `{ path, content }` |
| tool `read` | argumentos | `{ path }` |
| tool `bash` | argumentos | `{ command }` |

**Decisão:** o diff é derivado no renderer a partir dos argumentos acumulados —
`edit` → linhas `-oldText` / `+newText`; `write` → arquivo novo (só `+`). Sem `patch`,
cai no JSON cru (comportamento atual). Isso mantém o desenho do design system sem
inventar campo no protocolo.

---

## 1. Tokens (base de tudo)

Substituir o bloco `:root` atual pelos tokens do design system, em arquivo próprio
`src/renderer/styles/tokens.css` (hoje o CSS vive numa template string dentro do
`App.tsx` — 861 linhas; separar é pré-requisito para o resto).

### Escuro (padrão)

| Grupo | Tokens |
|---|---|
| Superfícies | `--bg-canvas #14121a` · `--bg-window #1a1820` · `--bg-surface #211e29` · `--bg-elevated #2a2633` · `--bg-inset #15131b` · `--bg-hover #2d2937` · `--bg-active #363041` |
| Traço | `--line #322d3d` · `--line-strong #453e54` |
| Texto | `--fg #f3f0f7` · `--fg-muted #a9a2b8` · `--fg-faint #978fa9` · `--fg-inverse #16131c` |
| Acento (Murasaki) | `--accent #9b84e8` · `--accent-hover #ad9aef` · `--accent-press #8669dd` · `--accent-soft rgba(155,132,232,.14)` · `--accent-line rgba(155,132,232,.34)` · `--on-accent #17131f` |
| Sinal | `--live #7fd0ff` · `--ok #63d3a6` · `--warn #e6b45c` · `--danger #f4786e` (+ `-soft`/`-line`) |
| Raio | `--r-xs 4` · `--r-sm 6` · `--r-md 10` · `--r-lg 14` · `--r-xl 20` · `--r-full 999` |
| Sombra | `--shadow-1/2/3` (níveis 1–3) |
| Movimento | `--ease cubic-bezier(.32,.72,0,1)` · `--d-1 120ms` · `--d-2 180ms` · `--d-3 260ms` |
| Layout | `--sidebar-w 260` · `--sidebar-collapsed 52` · `--topbar-h 46` · `--measure 760` |

### Claro (`[data-theme="light"]`)

Espelho completo: `--bg-canvas #e9e5ef`, `--bg-window #faf8fc`, `--bg-surface #f2eff6`,
`--bg-elevated #ffffff`, `--bg-inset #f4f1f8`, `--line #e0dae9`, `--fg #1b1722`,
`--accent #6a4fc0`, sinais escurecidos (`--live #1a6f9c`, `--ok #127354`,
`--warn #8a5c17`, `--danger #b93a30`), sombras com tinta violeta.

**Regra de escolha** (do design system): elemento que *contém* conteúdo sobe de
superfície; elemento que *flutua* sobe e ganha sombra. No escuro, elevação é
superfície + borda; sombra só em sobreposição real.

---

## 2. Tipografia

Três famílias, papéis que não se misturam:

| Papel | Família | Uso |
|---|---|---|
| voz | Source Serif 4 (fallback Iowan/Charter/Georgia) | **texto do agente** — 16.5px / 1.62 |
| interface | Inter (fallback SF Pro/Segoe) | chrome, botões, listas — 13px / 1.5 |
| sistema | JetBrains Mono | caminhos, tokens, contagens, argumentos de tool — 11.5px |

Escala: display 30/1.2 (−.022em, serifa) · title 19/1.35 (550) · lead 16.5/1.62 ·
body 15/1.6 · ui 13/1.5 (450) · micro 11.5/1.4 (mono).

Pesos: **só 400, 450, 550**. Nada de caixa-alta em rótulos.

**Fontes:** Inter e Source Serif 4 **não estão instaladas** no sistema (verificado com
`fc-list`); JetBrains Mono está. Bundlar as três em `src/renderer/fonts/` com
`@font-face` — o app é local, sem CDN.

---

## 3. Componentes (do design system)

| Componente | Especificação |
|---|---|
| **Botão** | 30px, raio 6, sans 12.5, peso 450. Variantes: `--primary` (acento, **um por tela**), `--ghost`, `--danger` (contorno + fundo de perigo, nunca primário), `--sm` (24px), `--icon` (30/24px), `is-on` (acento-soft + acento-line) |
| **Chip** | 22px, raio full, 11.5px — escolha exclusiva ou filtro. `--mono` para valores |
| **Pill** | 26px, raio full — **abre popover**, nunca ação imediata |
| **Campo** | 30px, `--bg-inset`, foco = borda acento + anel `--accent-soft` 3px |
| **Status** | ponto 6px + frase. `--live` pulsa 1.8s (único movimento sem ação do usuário). Sempre frase, nunca ícone sozinho |
| **Medidor de contexto** | 10 segmentos 3×9px: acento até 5, âmbar 6–8, vermelho 9+ |
| **Item de sessão** | ativo = superfície mais clara **+ borda** (nunca só peso de fonte); sem nome → 8 primeiros chars do id em mono |
| **Banner** | `--danger` / `--warn` / `--accent`, ícone + texto, raio 10 |
| **Card de tool** | cabeçalho (ícone + nome mono + estado à direita: `concluído em 320ms` / `executando…`), linha de meta (`arquivo +12 −4`), corpo = diff ou JSON |
| **Diff** | mono 11.5/1.9, nº de linha em `--fg-faint` (40px), fundo `--ok-soft`/`--danger-soft` a ~9%, sem coluna de sinal |
| **Diálogo** | `--bg-elevated`, borda `--line-strong`, `--shadow-2`, raio 14, ações à direita, cancelar sempre à esquerda |
| **Popover** | 268px fixo, `--shadow-3`, seções por hairline (nunca por espaço grande), abre **para cima** ancorado à pill |

---

## 4. Telas e estados (do protótipo)

### 4.1 Main — estados

| Tela | O que muda vs. hoje |
|---|---|
| Vazio / greeting | Serifa 30px "Boa tarde. O que vamos construir?" + "Noishi está pronto." + meta mono `CLI x · ~/cwd` |
| Streaming | Ponto `--live` pulsando, medidor de contexto, `12.4k · $0.0843` em mono, tool card em execução |
| Compactando | Banner `--warn` explicando o que o resumo substitui + status `compactando histórico · estimando resumo` |
| Erro de RPC | Banner `--danger`: "O processo do agente encerrou (código 1). A sessão foi preservada em disco." |
| Aguardando resposta | Banner `--accent` para a rota `code/needs-input` (hoje a rota é `break`, sem efeito) |
| Sidebar colapsada | 52px: marca, ícones de ação, nada mais |
| Sem sessões | "Nenhuma sessão ainda. Abra um projeto para começar." |

### 4.2 Main — sobreposições

| Tela | Situação atual |
|---|---|
| Painel Cowork | Existe; falta o cabeçalho `VM ativa · alpine-virt · sem rede` + `4 vCPU · 2 GB` e o output com prompt `~ $` |
| Dialog confirm | Existe; falta estilo (elevated + shadow-2) e o texto com `<code>` |
| Dialog select | Existe; opções viram chips mono |
| Dialog input | Existe; vira campo com foco anel |
| **Dialog editor** | **Não existe** — hoje `editor` cai em `cancelled`. Precisa de textarea + "Salvar e reenviar" |
| Popover de modelo | Existe; precisa 268px, seções por hairline, itens com check, Skills/MCP com contagem, instalar em acento |
| **Fork por mensagem** | **Não existe** — linha `msg-tools` sob a mensagem: Fork daqui / Copiar / Editar |
| **Renomear sessão inline** | **Não existe** — input direto no item da lista (`setTitle`) |

### 4.3 Outras janelas

| Janela | Hoje | Alvo |
|---|---|---|
| **Buddy** 760×560 | Renderiza a UI completa (o `?window=buddy` é passado e **ignorado**) | Topbar compacto (crumb + status + Parar + expandir), chat de medida fluida, composer. Sidebar colapsada por padrão |
| **Quick** 420×320 | Renderiza a UI completa (idem) | Cabeçalho (marca + status + pin + expandir), linha de contexto `~/cwd · modelo`, 3 linhas de histórico recente, composer com `Ctrl+Shift+Space` |
| **About** 320×260 | HTML estático com "N" | Marca SVG (N + ponto acento), versão, meta mono `motor: NoishiCLI (pi rpc)` / `CLI x · Electron 33` |
| **Tray** | 6 itens | + entrada "Quick window ⌃⇧Space" |
| **Artifact** 900×640 | Rota `cowork/shared-artifact` é `break` | Janela somente-leitura: cabeçalho (arquivo, badge, copiar link, exportar), documento, rodapé com a URL |

---

## 5. Fases de execução

### Fase A — Fundação visual (sem mudança de comportamento)
1. Extrair o CSS do `App.tsx` para `src/renderer/styles/` (`tokens.css`, `base.css`,
   `components.css`, `screens.css`).
2. Aplicar os tokens escuros + `[data-theme="light"]`.
3. `data-theme` no `<html>` lido de `nativeTheme.shouldUseDarkColors` (main → preload →
   renderer); `backgroundColor: "#1a1820"` nas 4 `BrowserWindow` (hoje `#111318`/`#191919`).
4. Bundlar Inter, Source Serif 4, JetBrains Mono; `@font-face` + `font-display: swap`.
5. Reestilizar componentes existentes: botões, chips, campos, item de sessão, status
   (ponto + medidor), banners, card de tool, diálogos, popover.
6. `prefers-reduced-motion` zera durações e o pulso; scrollbar 8px só no chat; foco
   visível em tudo.

**Aceite:** app idêntico em comportamento, visual do design system, tema claro
funcionando, sem flash branco no boot.

### Fase B — Chat e diffs
1. Bloco `text` do agente em serifa 16.5/1.62; cursor 7×16 em acento.
2. `thinking` com borda esquerda 2px e chevron rotativo.
3. Card de tool: cabeçalho com estado (`executando…` → `concluído`), meta de arquivo.
4. **Diff derivado dos argumentos**: `edit` → `-oldText/+newText`; `write` → só `+`;
   fallback JSON cru. (Ver §0.)
5. Banners de estado: compactando, erro de RPC, `code/needs-input`.

**Aceite:** um `edit` real renderiza diff com fundo verde/vermelho e números de linha.

### Fase C — Interações que faltam
1. Dialog `editor` (textarea + "Salvar e reenviar").
2. `msg-tools` por mensagem: Fork daqui (`fork` com `entryId`), Copiar, Editar.
3. Renomear sessão inline na lista (`setTitle`).
4. "Abrir projeto…" deixa de usar `window.prompt` → diálogo com campo.
5. Popover: 268px, seções por hairline, contagem de skills/MCP, instalar em acento.

**Aceite:** fork por mensagem cria sessão nova a partir daquele ponto; renomear persiste.

### Fase D — Janelas
1. Ler `?window=buddy|quick` no renderer → `data-mode` na raiz.
2. Buddy: topbar compacto, sidebar colapsada por padrão, medida fluida.
3. Quick: cabeçalho + contexto + histórico recente + composer.
4. About: marca SVG + meta mono.
5. Tray: entrada "Quick window".
6. Artifact: janela somente-leitura para `cowork/shared-artifact`.

**Aceite:** as quatro janelas têm a mesma gramática com densidades diferentes; nenhuma
mostra a UI completa por engano.

### Fase E — Verificação
1. `tsc --noEmit` + build.
2. Smoke headless (`probe/smoke.mjs`) continua PASS.
3. CDP: geometria do popover acima do composer; diff renderizado; tema claro/escuro.
4. Contraste: os pares texto/fundo do design system passam AA (o próprio arquivo calcula
   os ratios — usar como referência).

---

## 6. Riscos

| Risco | Mitigação |
|---|---|
| `patch.hunks` não existe no RPC | Diff derivado dos argumentos (§0); fallback JSON |
| Inter/Source Serif 4 ausentes no sistema | Bundlar em `src/renderer/fonts/` |
| CSS inline de 861 linhas dificulta tudo | Fase A começa extraindo para arquivos |
| Tema claro em janelas nativas (About/Quick) | `nativeTheme` + `backgroundColor` por tema |
| `?window=` ignorado hoje | Fase D lê o query param; sem isso buddy/quick continuam iguais à main |
| Regressão no e2e de chat/cowork | Smoke + CDP após cada fase |

---

## 7. Fora de escopo

- `chrome-native-host` e terminal embutido (já deferidos em `docs/PLAN.md`).
- Ícones: o protótipo usa um sprite SVG próprio; portar só os usados (send, stop, clone,
  compress, export, cpu, fork, copy, edit, plus, folder, panel, spark, terminal, check,
  chevron-down, expand, pin, x, alert, file, share, search).
