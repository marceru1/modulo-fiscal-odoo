# Fluxo do Orquestrador — Hermes + Orca + AGY

## Visão Geral

O Hermes é o orquestrador do pipeline de desenvolvimento. O usuário só trabalha com o Hermes e descreve o que quer. O Hermes decide qual skill aplicar, faz um pre-grill rápido, monta o prompt completo e abre o terminal certo no Orca.

## Pipeline

```
Hermes (orquestrador)
    │
    ├── 1. Pre-grill (3 perguntas)
    │
    ├── 2. Terminal do AGY (grill + spec + tickets)
    │       rtk agy --model claude-sonnet-4-6
    │
    ├── 3. Terminal do CODER (implementação)
    │       rtk ollama launch claude --model deepseek-v4-flash:cloud
    │
    └── 4. Terminal do REVIEWER (revisão)
            rtk ollama launch claude --model kimi-k2.7-code:cloud
```

## Passo a Passo

### Passo 1 — Requisição

O usuário abre o Hermes no workspace `my_addons/` e descreve a feature:

```
Usuário: "adicionar botão de teste no PDV"
```

O Hermes lê o AGENTS.md automático e identifica que é feature nova.

### Passo 2 — Hermes cria task no Obsidian PM

O Hermes cria um `.md` file em `Modulo Odoo_tasks/botao-teste-pdv.md` com:

```yaml
---
pm-task: true
projectId: "zk233d8lmsku7qbv"
title: "Botão de Teste no PDV"
status: "todo"
priority: "medium"
feature-slug: "botao-teste-pdv"
branch: "feat/botao-teste-pdv"
---
```

O task aparece automaticamente no Kanban do Obsidian (coluna Backlog).

### Passo 3 — Pre-grill (Hermes → Usuário)

O Hermes faz 3 perguntas rápidas:

1. O que exatamente a feature deve fazer? (uma frase)
2. Quais modelos/telas do Odoo são afetados? (ex: pos.order, receibo, fechamento)
3. Tem que funcionar em contingência/offline?

O usuário responde. O Hermes não gasta tokens à toa — só 3 perguntas.

### Passo 4 — Hermes abre terminal do AGY no Orca

O Hermes monta o prompt completo com:
- A skill certa (`fiscal-planner`)
- A descrição da feature expandida com as respostas do pre-grill
- Instrução de encadear `fiscal-taskbreaker` quando a spec ficar pronta

```bash
orca terminal create --worktree active --title "fiscal-planner" \
  --command "rtk agy --model claude-sonnet-4-6 --prompt-interactive '<PROMPT MONTADO>'" \
  --focus
```

### Passo 5 — Usuário trabalha no terminal do AGY

O agy no Orca:
- Carrega AGENTS.md automático
- Carrega a skill `fiscal-planner`
- Grilla o usuário sobre a feature
- Gera spec em `.agents/specs/<feature>.md`
- Carrega a skill `fiscal-taskbreaker`
- Quebra a spec em tickets em `.agents/tickets/<feature>/`
- Apresenta o checklist

Tudo no mesmo terminal, mesma sessão.

### Passo 6 — Usuário volta no Hermes

```
Usuário: "spec e tickets prontos, feature: botao-teste-pdv"
```

O Hermes atualiza o status do task no Obsidian PM para A Fazer e cria subtasks com os tickets do taskbreaker.

### Passo 7 — Hermes abre terminal do CODER no Orca

O Hermes abre o terminal com Claude Code + DeepSeek:

```bash
orca terminal create --worktree active --title "fiscal-coder" \
  --command "rtk ollama launch claude --model deepseek-v4-flash:cloud" \
  --focus
```

O Claude Code abre no workspace:
- Lê AGENTS.md automático
- Carrega a skill `fiscal-coder`
- Implementa os tickets um por um com TDD
- Sub-skills disparam automático:
  - `source-driven-development` — verifica doc oficial do Odoo 18
  - `doubt-driven-development` — revisão adversarial de decisões não-triviais
- Commita cada ticket com conventional commit

### Passo 8 — Usuário volta no Hermes

```
Usuário: "código pronto, PR aberto"
```

O Hermes atualiza o status do task no Obsidian PM para Revisão.

### Passo 9 — Hermes abre terminal do REVIEWER no Orca

O Hermes abre o terminal com Claude Code + Kimi:

```bash
orca terminal create --worktree active --title "fiscal-reviewer" \
  --command "rtk ollama launch claude --model kimi-k2.7-code:cloud" \
  --focus
```

O Claude Code abre no workspace:
- Lê AGENTS.md automático
- Carrega a skill `fiscal-reviewer`
- Revisa o diff desde dev nos 5 eixos (Correctness, Readability, Architecture, Security, Performance)
- Sub-skill `code-simplification` dispara se achar smell
- Salva relatório em `.agents/reviews/<feature>-<data>.md`

### Passo 10 — Usuário volta no Hermes

```
Usuário: "review passou" ou "review achou X problemas"
```

O Hermes atualiza o status no Obsidian PM:
- Review passou → Teste
- Review falhou → Em Andamento (volta pro coder corrigir)

### Passo 11 — Resultado

- **Review passou** → usuário testa manualmente no PDV → mergeia PR → avisa o Hermes pra limpar branches
- **Review falhou** → Hermes reabre o terminal do coder com o relatório da review pra corrigir

## Regras do Orquestrador

| Regra | Detalhe |
|-------|---------|
| Usuário só fala com o Hermes | Nunca abre terminal manualmente |
| Hermes monta o prompt | Nunca joga o texto cru do usuário no agy |
| Pre-grill sempre | 3 perguntas antes de abrir o agy |
| Um terminal por fase | Planner+taskbreaker juntos, coder separado, reviewer separado |
| Usuário avisa entre fases | "spec pronta", "código pronto", "review passou" |
| Bugfix não precisa de pipeline | Hermes faz direto se for uma linha/import |
| Pergunta não precisa de pipeline | Hermes responde direto |

## Ferramentas por Fase

| Fase | Ferramenta | Modelo | Skills |
|------|-----------|--------|--------|
| Pre-grill | Hermes | GLM 5.2 | — |
| Planner + Taskbreaker | AGY | Claude Sonnet 4.6 | `fiscal-planner`, `fiscal-taskbreaker` |
| Coder | Claude Code | DeepSeek V4 Flash | `fiscal-coder`, `source-driven-development`, `doubt-driven-development` |
| Reviewer | Claude Code | Kimi K2.7 | `fiscal-reviewer`, `code-simplification` |

## Ver Diffs no Orca

```bash
orca file open-changed --mode diff      # todos arquivos changed
orca file diff <path>                    # diff de um arquivo
orca file diff <path> --staged           # diff staged
```

## Ler Output de Terminal

```bash
orca terminal list --json                # listar terminais ativos
orca terminal read --terminal <handle>   # ler output de um terminal
```