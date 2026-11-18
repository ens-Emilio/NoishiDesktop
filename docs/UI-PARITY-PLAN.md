# Paridade de UI com o Claude Desktop — plano de execução

Fonte: **Claude Desktop 4.23118.0** instalado nesta máquina
(`/usr/lib/claude-desktop`, `.deb` oficial verificável). A UI vive em
`resources/ion-dist.asar`; os tokens e regras abaixo foram **extraídos do CSS
empacotado**, não copiados de screenshot.

Artefato bruto da extração: [`docs/reference/claude-tokens.json`](reference/claude-tokens.json)
(352 cores de paleta, 238 tokens semânticos claros, 76 escuros, geometria).

## 0. Diagnóstico: por que a UI atual parece saturada

| Sintoma no Noishi | Causa medida | O que o Claude faz |
|---|---|---|
| Roxo em tudo | `var(--accent*)` aparece **24×** em `screens.css`; botão "Nova conversa" é preenchido com acento | acento é **azul `#2a78d6`, usado em foco e link**; a marca é **clay `#d97757`**, e só no detalhe |
| Fundo chapado | `--bg-canvas #14121a` único para janela e página | **4 superfícies** escalonadas (`#0b0b0b → #151515 → #1a1a19 → #20201f`) + página = superfície 0 |
| Bordas duras | `--line #322d3d` sólido em tudo | borda é **alpha do neutro** (10% / 20%), nunca hex próprio |
| Tipografia uniforme | 15px base, tudo igual | escala de 5 tamanhos (11/12/13/14/20), 4 pesos (400/500/580/600), serif só no "voice" |
| Espaço vazio sem hierarquia | medida 760px, sidebar 260px | sidebar **288px**, medida de transcrição **768/960/1280** por breakpoint, gutters em `clamp()` |
| Sem profundidade | 3 níveis de sombra genéricos | sombras com **anel duplo** (inner 1px + outer 1px) e blur longo; composer tem sombra própria de 0.25rem/1.25rem |
| Sem movimento | `--d-1/2/3` = 120/180/260ms | **4 durações** (60/120/200/450ms) e 3 curvas, incluindo `snap` |

## 1. Tokens (fase 1 — base de tudo)

### 1.1 Paleta extraída (valores reais)

```
gray    0 #ffffff   10 #fcfcfb   20 #f9f9f7   30 #f6f6f4   40 #f3f3f0
       50 #f0efec   60 #edece8   70 #eae9e4  100 #e1e0d9  150 #d2d1c7
      200 #c3c2b7  250 #b4b3a8  300 #a5a49a  400 #898781  500 #6d6b67
      600 #52514e  700 #383835  750 #2c2c2a  800 #20201f  830 #1a1a19
      850 #151515  900 #0b0b0b
clay    #d97757  emphasized #c6613f        ← marca
blue    450 #2a78d6  400 #3987e5  300 #6da7ec  700 #0d366b  800 #032042
violet  450 #7161e0  300 #a096eb  700 #322777
green   450 #009300  300 #55bf50  700 #074506
red     450 #d03b3b  300 #ec7e7e  700 #641919
yellow  200 #fab219  300 #db9300  700 #512e00
```

**Regra de substituição**: `--accent` (roxo) deixa de ser cor de marca e passa a
ser **azul de interação** (`blue-450`); o clay entra só em logo/spark/CTA
primária. Isso sozinho remove a saturação.

### 1.2 Semânticos (escuro → claro)

| Token | Escuro | Claro |
|---|---|---|
| `--surface-0` (página) | `#0b0b0b` | `#f9f9f7` |
| `--surface-1` (sidebar) | `#151515` | `#fcfcfb` |
| `--surface-2` (composer/card) | `#1a1a19` | `#ffffff` |
| `--surface-3` (popover) | `#20201f` | `#ffffff` |
| `--text-primary` | `#f0efec` | `#0b0b0b` |
| `--text-secondary` | `#c3c2b7` | `#52514e` |
| `--text-muted` | `#898781` | `#898781` |
| `--border` | neutro @10% | idem |
| `--border-strong` | neutro @20% | idem |
| `--fill-ghost-hover` | neutro @7.5% | @5% |
| `--fill-ghost-selected` | neutro @15% | @10% |
| `--fill-primary` | `#f0efec` (invertido) | `#0b0b0b` |

### 1.3 Geometria

```
sidebar 288px · header 48px · row 32px · row font 14px · group font 13px
leading slot 28px · icon 20px · footer btn 32px · radius pill 8px
control height 24px · composer radius 12px
transcript 768px (compacto) / 960px / 1280px (wide) · chat measure 850px
greeting clamp(1.875rem, 1.2rem + 2vw, 2.375rem) / line-height 1.25
```

### 1.4 Tipografia

```
caption 11/17 · footnote 12/15 · code 12/17 · body 13/19 · heading 14/18 · prose 14/20 · title 20/25
peso: regular 400 · medium 500 · semibold 580 · bold 600
famílias: sans (UI) · serif (voz/discurso) · mono (código) · display (títulos grandes)
```

### 1.5 Movimento e elevação

```
dur: fast 60ms · snap 120ms · base 200ms · slow 450ms
ease: out cubic-bezier(.165,.84,.44,1) · snap cubic-bezier(.32,.72,0,1)
      overshoot cubic-bezier(.34,1.3,.64,1)
sombra: sm/md/lg/popover + anel duplo (inset 1px + outer 1px)
composer: 0 .25rem 1.25rem rgb(0 0 0 / 3.5%) + anel 1px na borda
composer foco: mesmo blur com 7.5% + anel border-strong
foco global: inset 0 0 0 1px page-bg, 0 0 0 1px accent, 0 0 6px 1px accent@60%
```

## 2. Fases

### Fase A — Tokens e camada base (sem tocar em componentes)

1. Reescrever `styles/tokens.css` com a paleta e os semânticos acima, mantendo
   **nomes neutros** (`--surface-*`, `--text-*`, `--border*`) e um bloco
   `[data-theme="light"]` espelhado.
2. Adicionar camada de compatibilidade temporária: `--bg-canvas: var(--surface-0)`,
   `--fg: var(--text-primary)`, `--accent: var(--interactive)` etc., para o
   `screens.css` atual continuar renderizando durante a migração.
3. `base.css`: escala tipográfica nos 5 tamanhos, foco com `--focus-shadow`,
   `prefers-reduced-motion`.

**Aceite**: app renderiza igual em estrutura, mas com fundo escalonado, texto
hierárquico e foco correto. Nenhum componente reescrito ainda.

### Fase B — Shell (janela, titlebar, sidebar)

| Peça | Escala do Claude | Ação |
|---|---|---|
| Janela | `frame:false`, `titleBarStyle:'hidden'`, fundo transparente | aplicar em `createMainWindow` |
| Titlebar | 48px, marca à esquerda, ações à direita, sem borda | nova `.titlebar` |
| Sidebar | 288px; 52px colapsada; fundo = superfície 1 | `--sidebar-w: 288px` |
| Nova conversa | **pill** 32px, fundo `--fill-ghost-hover`, ícone + rótulo, **sem** preenchimento de acento | reescrever `.sidebar-actions` |
| Seções | rótulo 13px `--text-muted`, contador mono 11px, reveal no hover | `.sidebar-section` |
| Linha de sessão | 32px, raio 8px, hover `--fill-ghost-hover`, selecionada `--fill-ghost-selected`, menu só no hover | `.session-item` |
| Rodapé | avatar 32px + nome + chevron | novo |
| Busca | campo 24px com atalho `⌘K` revelado no foco | `.session-search` |

**Aceite**: sidebar idêntica em proporção e densidade; nenhum roxo preenchido.

### Fase C — Chat

1. **Medida e gutters**: coluna centrada com `max-width: 768px` e gutter
   `clamp(16px, (100cqw - medida - 16px) * .4 + 16px, 32px)`.
2. **Mensagem do usuário**: bolha `--surface-2`, raio 12, sem borda; sem avatar.
3. **Mensagem do agente**: sem bolha, texto em `prose 14/20`, medidas de
   `--msg-text-inset`.
4. **Turn status** (novo): linha 13px `--text-secondary` mostrando a etapa
   ("lendo 3 arquivos…"), com passo atual destacado — hoje o Noishi só tem
   instruções soltas.
5. **Ações da mensagem**: aparecem no hover (`opacity` animado 120ms), chips 24px.
6. **Scroll fade**: máscaras de 28px no topo/base em vez de corte seco.
7. **Greeting**: `clamp(1.875rem…)`, serif, spark clay 1em antes do texto;
   sugestões em grade de 2 colunas com cards `--surface-1`/hover `--surface-2`.

**Aceite**: conversa longa não "corta" nas bordas; greeting com spark e sugestões.

### Fase D — Composer

1. Container `--surface-2`, raio 12px, sombra própria, anel 1px; foco troca para
   `--border-strong` + blur 7.5%.
2. Editor com altura mínima de 2 linhas e `max-height: min(24rem, 60dvh - 7.8rem)`.
3. **Chin** (barra inferior): modelo, esforço, anexo, voz — chips 24px
   `--text-muted`, hover `--text-primary`.
4. **Fila**: `--surface-1`, raio 8, itens 32px, contador "N na fila".
5. **Avisos**: banner acima do composer (`--bg-warning` em 20%), não no fluxo do chat.

**Aceite**: composer com anel duplo, chin completa, fila visível acima.

### Fase E — Componentes do design system

Portar os 65 `data-cds` usados pelo Claude, com os que o Noishi realmente precisa:

```
Button (primary/ghost/secondary + icon) · TextInput · TextArea · Combobox
SegmentedControl · Tabs/NavigationTabs · Badge · Meter · Card/CardLink
Accordion · Collapsible · Switch · Checkbox · Tooltip/OverflowTooltip
Panel · Surface · Skeleton/ShimmerText/Spinner · Banner · PreviewCard
FileDiff/DiffIndicator · UserMessage/AssistantMessage · MessageActions
ChatComposer(+Actions/Chin/Notices/QueuedMessages/Editor)
ModelSelector/ModelSelectorEffort · TurnStatus/TurnStatusStep
```

Sugestão: um `styles/cds.css` com **um componente por bloco**, classes
`.cds-btn`, `.cds-input`, e `data-*` para variantes — o mesmo vocabulário do
Claude, para o CSS continuar portável.

**Aceite**: cada componente tem estados hover/active/disabled/focus-visible e
os 3 tamanhos (sm 24 / md 32 / lg 40).

### Fase F — Painéis novos na mesma linguagem

Revisão, Git, Contexto e Ajustes hoje usam tabelas densas de 10.5px. Migrar para:
`Panel` com cabeçalho 48px, linhas 32px, `Badge` para status, `FileDiff` real
(lado a lado com `DiffIndicator`), `Meter` no contexto.

**Aceite**: os quatro painéis usam apenas componentes do `cds.css`.

### Fase G — Movimento

- Entrada de mensagem: `fade + translateY(10px)` 200ms.
- Sidebar colapsar: 200ms `snap`, largura e rótulos juntos.
- Popover: 120ms `snap` + escala 0.98→1.
- Trocar de aba: sem animação (evita sensação de lentidão).
- Tudo atrás de `prefers-reduced-motion`.

**Aceite**: nenhuma animação acima de 450ms; redução de movimento respeitada.

## 3. Backend — o que vale copiar do Claude Desktop

O `app.asar` (main process, 986 arquivos) foi mapeado. O que é **portável** sem
depender de serviço da Anthropic:

| Recurso | Onde está | Vale para o Noishi? |
|---|---|---|
| 7 janelas: main/buddy/quick/about/artifact/design/cowork-artifact | `.vite/build/*Window.js` | **sim** — faltam `design` e `artifact-pane` |
| `titleBarStyle:'hidden'` + fundo transparente | `index.chunk-BKTPbgey.js` | sim (fase B) |
| Skills empacotadas: `docx`, `pdf`, `pdf-reading`, `pptx`, `xlsx`, `frontend-design` | `resources/bundled-skills/*.skill` + `manifest.json` com `tier: always` | **sim** — hoje o Noishi só instala .skill externos |
| MCP embarcados: `github-mcp`, `office365-mcp` | `resources/*-mcp` | sim (github); office365 depende de OAuth próprio |
| Libs de artifact: mermaid 11.17.2, chart.js 4.5.0, gridjs 5.0.2 | `resources/artifact-libs` | **sim** — o Noishi não renderiza mermaid |
| Frame types: `design`, `slides` | `resources/frame/types/*` | avaliação: o Noishi não tem editor de slides |
| `printFrameToPdf` (artifact → PDF) | preload `omeletteDesktopPdf` | **sim** — complementa o `exportPdf` que já existe |
| Busca de arquivos com worker (`file-index-worker`) | `.vite/build/file-index-worker` | **sim** — hoje a busca é síncrona e limitada |
| `heavy-work-worker` (tarefas fora do main) | `.vite/build/heavy-work-worker` | sim, se aparecer travamento |
| Cowork VM (`smol-bin` + `srt-settings.json`) | `resources/smol-bin.x64.img` | **não copiar** — binários fechados; o sandbox próprio já cobre |
| Telemetria OTel, login, billing, orgs | main bundle | **não** — depende de backend Anthropic |

Nota ética/técnica: copiar **CSS, tokens, geometria e padrões de interação** é
engenharia reversa de layout; copiar os `.skill`/MCP empacotados é redistribuir
conteúdo da Anthropic — os skills devem ser **reimplementados** com o mesmo
propósito (o Noishi já tem o formato `.skill`).

## 4. Ordem de execução e esforço

| Fase | Escopo | Esforço | Bloqueia |
|---|---|---|---|
| A | Tokens + base | 1 | tudo |
| B | Shell/sidebar/titlebar | 1–2 | C, D |
| C | Chat | 2 | — |
| D | Composer | 1 | — |
| E | Componentes `cds` | 2 | F |
| F | Painéis | 1 | — |
| G | Movimento | 0.5 | — |
| Backend | skills, mermaid, pdf, file-index | 2–3 | — |

## 5. Verificação

- `probe/a11y.mjs` deve continuar 11/11 (contraste e rótulos são pré-requisito).
- Novo `probe/visual.mjs`: screenshots por aba em claro/escuro, comparados por
  hash perceptual — falha se a densidade da sidebar ou a altura de linha mudar.
- Contraste medido (não estimado): `#898781` sobre `#151515` = **5.08:1**;
  `#c3c2b7` = 10.19; `#f0efec` = 15.88; `#6d6b67` sobre `#fcfcfb` = 5.18;
  `#52514e` = 7.73; `#a5a49a` sobre `#0b0b0b` = 7.85. Todos passam AA.
  `probe/contrast-check.mjs` recalcula esses pares no app rodando.
- `npm run check && npm run lint && npm run build` em cada fase.

---

## 6. Executado: camada de interação (2026-11-16)

Paleta do Noishi mantida. O que mudou foi **como os controles respondem** —
extraído do `cds.css` do Claude, não inventado.

### Tokens novos (`tokens.css`)

| Token | Valor | Origem no Claude |
|---|---|---|
| `--press-scale` | `0.975` | `--cds-btn-press-sx/sy` |
| `--press-scale-soft` | `0.99` | `--cds-card-press-sx/sy` |
| `--ease-spring` | `linear(0, .2459, .6526, .9468, 1.0764, …)` | `--cds-btn-spring` (14 pontos) |
| `--ease-out` | `cubic-bezier(.165,.84,.44,1)` | `--cds-ease-out` |
| `--d-fast/snap/base/slow` | 60/120/200/450ms | `--cds-dur-*` |
| `--focus-ring` | `inset 0 0 0 1px page, 0 0 0 1px accent, 0 0 6px 1px accent@14%` | `--cds-focus-shadow` |
| `--shadow-field` | `0 1px 2px rgba(0,0,0,.18)` | sombra de campo |
| `--fill-control(-hover/-press)` | superfícies em camadas | `--cds-fill-*` |

### Componentes tratados

`.btn` (+ ghost/primary/danger/sm/icon) · `.chip` · `.pill` · `.field` ·
`.icon-btn` · `.session-item` · `.view-tab` · `.tree-row` · `.popover-item` ·
`.slash-item` · `.composer` · `.composer-send`

Cada um: fundo em 60ms, `:active` com `scale` e retorno em 450ms pela mola,
`:focus-visible` com anel duplo + halo, `:disabled` a 38%.

### Correções de apresentação

| Antes | Depois | Por quê |
|---|---|---|
| "Nova conversa" preenchido de roxo | linha de superfície, ícone em acento | área grande saturada rebaixa tudo à volta |
| Enviar 28px quadrado | 32px circular, acento só quando há texto | alvo de clique + um único ponto de cor |
| Composer 68px / 3 linhas | 40px / 1 linha, cresce até 40vh | caixa de comentário vs. barra de mensagem |
| Campos de Ajustes full-width | 240px (96 numérico, 180 select) | formulário de site vs. painel de app |
| Scrollbar padrão do Chromium | 10px, thumb translúcido com `background-clip` | o detalhe que mais entrega "página web" |
| `prefers-reduced-motion` duplicado | um bloco, neutraliza `transform` também | scale é movimento |

### Verificação

`probe/press-check.mjs` — **12/12**, com press real via CDP:
`matrix(0.975, 0, 0, 0.975, 0, 0)` durante o clique, `none` ao soltar.
`probe/a11y.mjs` 11/11 (o probe agora resolve `<label for>` de verdade).
`probe/panels.mjs` 11/11. `check`, `lint`, `build` limpos.

---

## 7. Executado: shell e etapa do turno (2026-11-16)

### Janela sem moldura

`frame:false` + `titleBarStyle:"hidden"` + `thickFrame:true` em `createMainWindow`.
No Linux `titleBarStyle` não existe, então os botões de janela passam a ser
nossos — sem eles a janela ficaria impossível de fechar.

| Peça | Implementação |
|---|---|
| Faixa arrastável | `.topbar { -webkit-app-region: drag }`, 48px |
| Controles dentro | `no-drag` em botões, abas, campo, status e `.window-controls` |
| Minimizar / maximizar / fechar | `windowControl` na ponte → `win.minimize()/maximize()/close()` |
| Estado | `windowState` → `{ maximized, fullscreen }` |
| Fechar | vermelho só no hover, como app nativo |

### Densidade da sidebar

`--sidebar-w 288px` · `--topbar-h 48px` · `--row-h 32px` · `--row-font 13.5px` ·
`--row-radius 8px` · `--group-font 12px` · `--measure 768px`.
Linha de sessão virou flex de altura mínima 32px; banda de seção 28px; gap 2px.

### Etapa do turno

`turnStep`: durante o streaming o cabeçalho mostra o que está acontecendo —
"lendo arquivo…", "rodando comando · concluído", "escrevendo…" — via
`TOOL_LABELS`, em vez do genérico "streaming".

### Verificação

`probe/window-controls.mjs` — **7/7**, com efeito real: `maximize` deixa
`windowState.maximized === true`, o segundo clique restaura, e ação inválida é
recusada. Somado a `press-check` 12/12, `a11y` 11/11, `panels` 11/11,
`rpc-contract` 17/17, mais os quatro E2E de painel.
