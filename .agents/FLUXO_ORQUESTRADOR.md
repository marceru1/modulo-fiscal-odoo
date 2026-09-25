# Fluxo do Orquestrador — Hermes (pane Orca) + Split no mesmo workspace

## Visão Geral

O Hermes roda como pane dentro do Orca, no workspace `my_addons/`. O usuário só trabalha com o Hermes e descreve o que quer. O Hermes decide qual skill aplicar, faz um pre-grill rápido, monta o prompt completo e **splita o terminal no MESMO workspace** pra fase seguinte. Sem worktree por padrão — worktree só pra 2+ features em paralelo.

## Pipeline

```
Hermes (pane no Orca, workspace my_addons) — orquestrador
    │
    ├── 1. Pre-grill (3 perguntas) + task no Obsidian PM
    ├── 2. SPLIT → agy (Claude Sonnet 4.6): fiscal-planner + fiscal-taskbreaker
    ├── 3. SPLIT → Claude Code (deepseek-v4.1-flash:cloud): fiscal-coder, TDD
    └── 4. SPLIT → Claude Code (kimi-k2.7-code:cloud): fiscal-reviewer, 5 eixos
```

Cada split abre uma nova pane filha da pane do Hermes. Todas enxergam o mesmo diretório `/Users/marceloC/Desktop/odoo-18.0/my_addons` — spec, tickets, código e relatórios ficam visíveis pra todas as fases na hora.

## Passo a Passo

### Passo 1 — Requisição

O usuário fala com o Hermes na pane do Orca:

```
Usuário: "adicionar botão de teste no PDV"
```

O Hermes lê o AGENTS.md automático e identifica que é feature nova.

### Passo 2 — Hermes cria task no Obsidian PM

O Hermes cria um `.md` em `Modulo Odoo_tasks/botao-teste-pdv.md` (formato no AGENTS.md). O task aparece no Kanban, coluna Backlog.

### Passo 3 — Pre-grill (Hermes → Usuário)

3 perguntas rápidas:

1. O que exatamente a feature deve fazer? (uma frase)
2. Quais modelos/telas do Odoo são afetados? (ex: pos.order, receibo, fechamento)
3. Tem que funcionar em contingência/offline?

### Passo 4 — Hermes splita o terminal pro PLANNER (agy)

O Hermes descobre o próprio handle (`orca terminal list --json`, pane com título "hermes" no workspace my_addons) e splita:

```bash
orca terminal split --terminal <handle-da-pane-hermes> --direction horizontal \
  --command "rtk agy --model claude-sonnet-4-6 --prompt-interactive '<PROMPT MONTADO>'" --json
```

O prompt monta com:
- A skill `fiscal-planner`
- A descrição da feature expandida com as respostas do pre-grill
- Instrução de encadear `fiscal-taskbreaker` quando a spec ficar pronta

**Importante:** o handle alvo do split é o da pane do Hermes (ou da pane ativa no my_addons), NUNCA o de outra sessão. O `split` retorna o handle da nova pane em `result.split.handle` — usar esse handle pra leituras posteriores (`terminal read`). Antes de enviar prompt pra pane recém-criada, esperar o TUI inicializar (`orca terminal wait --terminal <handle> --for tui-idle`).

O agy carrega AGENTS.md automático, grilla o usuário, gera spec em `.agents/specs/<feature>.md` + ADRs, encadeia o taskbreaker e quebra em tickets em `.agents/tickets/<feature>/`. Tudo na mesma pane, mesma sessão.

### Passo 5 — Usuário volta no Hermes

```
Usuário: "spec e tickets prontos, feature: botao-teste-pdv"
```

O Hermes atualiza o task pra A Fazer e cria subtasks com os tickets.

### Passo 6 — Hermes splita o terminal pro CODER (Claude Code + DeepSeek)

```bash
orca terminal split --terminal <handle-da-pane-hermes> --direction horizontal \
  --command "rtk ollama launch claude --model deepseek-v4-flash:cloud --yes -- '<PROMPT DO CODER>'" --json
```

Mesmo workspace: o coder cria a branch da feature (`git checkout -b feat/<slug>`) e trabalha nela. Prompt do coder: carrega `fiscal-coder`, implementa os tickets um por um com TDD, lê a spec em `.agents/specs/<feature>.md`, pula verificação de ambiente (Odoo não roda local), não faz push nem abre PR, e escreve relatório em `.agents/code-reports/<feature>.md`.

O usuário aceita as permissões de escrita manualmente no terminal (y/Enter).

### Passo 7 — Usuário volta no Hermes

```
Usuário: "código pronto"
```

O Hermes move o task pra Revisão.

### Passo 8 — Hermes splita o terminal pro REVIEWER (Claude Code + Kimi)

```bash
orca terminal split --terminal <handle-da-pane-hermes> --direction horizontal \
  --command "rtk ollama launch claude --model kimi-k2.7-code:cloud --yes -- '<PROMPT DO REVIEWER>'" --json
```

O reviewer le o relatório do coder, revisa o diff desde dev nos 5 eixos e salva em `.agents/reviews/<feature>-<data>.md`. Não faz push nem PR.

### Passo 9 — Resultado

- **Review passou** → Hermes move pra Teste → usuário testa manualmente no PDV → PR (`feat/<slug>` → dev) → merge → Hermes limpa branch e move pra Concluído
- **Review falhou** → Hermes move pra Em Andamento e splita novo terminal do coder com o relatório da review

## Features em paralelo (exceção)

Só quando rodar 2+ features ao mesmo tempo (o padrão do Marcelo é 1 por vez):

```bash
orca worktree create --name <feature-slug> --base-branch dev --activate
orca terminal create --worktree branch:<feature-slug> --title "fiscal-coder" --command "..." --focus
```

Cada feature na sua worktree; ao mergear, `orca worktree rm --worktree branch:<feature-slug> --force`.

## Regras do Orquestrador

| Regra | Detalhe |
|-------|---------|
| Usuário só fala com o Hermes | Nunca abre terminal manualmente |
| Hermes monta o prompt | Nunca joga o texto cru do usuário no agy |
| Pre-grill sempre | 3 perguntas antes de abrir o agy |
| Split no mesmo workspace | Uma pane por fase, todas filhas da pane do Hermes |
| Sem worktree por padrão | Worktree só pra features em paralelo |
| Branch da feature no coder | `git checkout -b feat/<slug>` (a partir de dev) |
| Usuário avisa entre fases | "spec pronta", "código pronto", "review passou" |
| Bugfix não precisa de pipeline | Hermes faz direto se for uma linha/import |
| Pergunta não precisa de pipeline | Hermes responde direto |

## Ferramentas por Fase

| Fase | Ferramenta | Modelo | Skills |
|------|-----------|--------|--------|
| Pre-grill | Hermes | GLM 5.2 | — |
| Planner + Taskbreaker | AGY (split) | Claude Sonnet 4.6 | `fiscal-planner`, `fiscal-taskbreaker` |
| Coder | Claude Code (split) | DeepSeek V4 Flash | `fiscal-coder`, `source-driven-development`, `doubt-driven-development` |
| Reviewer | Claude Code (split) | Kimi K2.7 | `fiscal-reviewer`, `code-simplification` |

## Por que não `worker-start` supervisionado

`orca orchestration worker-start --agent antigravity` crasha o agy no macOS (Electron `FATAL:electron_main_delegate_mac.mm` → trace trap). O agy só funciona via `terminal split`/`terminal create`. Pra coder/reviewer em Claude Code a orquestração supervisionada funciona, mas o fluxo atual usa handoff por split — o Hermes monitora pelas transições que o usuário anuncia e lendo os terminais (`orca terminal read`).

## Ver Diffs no Orca

```bash
orca file open-changed --mode diff      # todos arquivos changed
orca file diff <path>                    # diff de um arquivo
orca file diff <path> --staged           # diff staged
```

## Ler Output de Terminal

```bash
orca terminal list --json                # listar panes (achar o handle do Hermes)
orca terminal read --terminal <handle>   # ler output de uma pane
orca worktree ps                         # worktrees ativas (modo paralelo)
```