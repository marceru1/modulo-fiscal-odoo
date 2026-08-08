# AGENTS.md — Workspace Odoo 18 Fiscal Module

## Propósito

Este workspace contém o módulo customizado `meu_modulo_fiscal` para Odoo 18, que adiciona controle tributário (NCM, CFOP, PIS/COFINS) e integra o PDV com Middleware de NFC-e (Focus NFe).

## Pipeline

```
┌──────────────────────┐       ┌─────────────────┐        ┌─────────────────┐
│ fiscal-planner      │       │  fiscal-coder   │ ──►     │ fiscal-reviewer │
│ Grill → Spec        │ ──►  │  Lê tasks e      │         │ Spec + Quality  │
└──────────┬───────────┘       │  implementa     │        └─────────────────┘
           ▼                   └─────────────────┘
┌──────────────────────┐
│ fiscal-taskbreaker  │
│ Spec → Tasks        │
└──────────────────────┘
```

## Skills

### Skills principais (fases do pipeline)

| Skill | Fase | Uso |
|-------|------|-----|
| `fiscal-planner` | Define | Grilla a task, produz spec em `.agents/specs/` |
| `fiscal-taskbreaker` | Plan | Quebra spec em tasks em `.agents/tickets/` |
| `fiscal-coder` | Build | Lê as tasks e implementa uma por uma |
| `fiscal-reviewer` | Review | Revisa spec compliance + code quality |

### Sub-skills (disparam automaticamente dentro das fases)

| Skill | Fase que dispara | Gatilho |
|-------|------------------|---------|
| `source-driven-development` | coder (antes de codar) | Toda task que envolve API do Odoo 18. Verificar doc oficial, citar fonte, flagar nao-verificado. |
| `doubt-driven-development` | coder (decisao nao-trivial) | Modelo fiscal, reconciliacao, calculo residual, etc. CLAIM-EXTRACT-DOUBT-RECONCILE-STOP. |
| `code-simplification` | reviewer (ao achar smell) | Duplicated Code, Long Method, etc. Chesterton Fence, Rule of 500. |
| `debugging-and-error-recovery` | teste (quando PDV falha) | 5 passos: reproduzir, localizar, reduzir, fixar, guardar. |
| `deprecation-and-migration` | taskbreaker (ao identificar legado) | Spec envolve remover/modificar codigo existente. Codigo como liability. |

## Estrutura de Arquivos

```
my_addons/
├── AGENTS.md              ← este arquivo (única fonte de regras)
├── .agents/
│   ├── specs/             ← specs geradas pelo planner
│   │   └── <feature-slug>.md
│   ├── tickets/           ← tasks quebradas pelo taskbreaker
│   │   └── <feature-slug>/
│   │       ├── 01-<title>.md
│   │       └── 02-<title>.md
│   └── reviews/           ← relatórios de review
│       └── <feature-slug>-<date>.md
└── meu_modulo_fiscal/     ← o módulo Odoo
```

## Entry Point

O Hermes é o orchestrador. O usuário descreve o que quer e o Hermes decide:

1. **Feature nova** (precisa de grill + spec + tickets + code + review) → faz pre-grill de 3 perguntas basicas com o usuario, monta o prompt completo, e abre terminal do agy no Orca
2. **Bugfix simples** (uma linha, um import) → faz direto no Hermes
3. **Pergunta** (status, dúvida, explicação) → responde direto

### Pre-grill (antes de abrir o agy)

O Hermes faz 3 perguntas rapidas pra montar o prompt com contexto maximo:

1. O que exatamente a feature deve fazer? (uma frase)
2. Quais modelos/telas do Odoo sao afetados? (ex: pos.order, receibo, fechamento)
3. Tem que funcionar em contingencia/offline?

Com as respostas, o Hermes monta o prompt completo pro agy com a skill certa + contexto + encadeamento de fases.

### Comando base pra abrir terminal do agy no Orca

```bash
orca terminal create --worktree active --title "<skill>" \
  --command "rtk agy --model claude-sonnet-4-6 --prompt-interactive '<PROMPT COM A SKILL E A DESCRICAO DA FEATURE>'" \
  --focus
```

O Hermes monta o prompt com:
- A skill certa (`fiscal-planner`, `fiscal-coder`, `fiscal-reviewer`)
- A descrição da feature que o usuário passou
- Instrução pra encadear fases no mesmo terminal quando fizer sentido (planner → taskbreaker)

## Workflow (Obsidian PM + Git + Orca)

```
BACKLOG → A FAZER → EM ANDAMENTO → REVISÃO → TESTE → CONCLUÍDO
```

**A FAZER:**

1. **Abrir terminal do planner no Orca** (Hermes gera o comando, você roda):

```bash
orca terminal create --worktree active --title "fiscal-planner" \
  --command "rtk agy --model claude-sonnet-4-6 --prompt-interactive 'Carrega a skill fiscal-planner e me grilla sobre: <DESCREVA A FEATURE>'" \
  --focus
```

O agy abre no workspace com Claude Sonnet 4.6, carrega AGENTS.md automático, e inicia o grill. Ao final: spec em `.agents/specs/<feature>.md` + ADRs + título do task no Obsidian PM.

2. **Abrir terminal do taskbreaker** (depois que a spec estiver pronta):

```bash
orca terminal create --worktree active --title "fiscal-taskbreaker" \
  --command "rtk agy --model claude-sonnet-4-6 --prompt-interactive 'Carrega a skill fiscal-taskbreaker e quebra a spec em .agents/specs/<feature>.md em tickets'" \
  --focus
```

3. No Obsidian PM: cria task no projeto "Modulo Odoo" com o título sugerido, anexa checklist, move pra Em andamento

**EM ANDAMENTO:**

1. Cria branch `feat/<slug>` a partir de dev

2. **Abrir terminal do coder:**

```bash
orca terminal create --worktree active --title "fiscal-coder" \
  --command "rtk ollama launch claude --model deepseek-v4-flash:cloud" \
  --focus
```

O Claude Code abre no workspace com DeepSeek, le AGENTS.md automaticamente, e carrega a skill `fiscal-coder`. Instruir o agente a implementar os tickets em `.agents/tickets/<feature>/` um por um com TDD. Sub-skills `source-driven-development` e `doubt-driven-development` disparam automatic.

3. Push + PR (`feat/<slug>` → dev)

4. **Abrir terminal do reviewer:**

```bash
orca terminal create --worktree active --title "fiscal-reviewer" \
  --command "rtk ollama launch claude --model kimi-k2.7-code:cloud" \
  --focus
```

O Claude Code abre com Kimi K2.7, le AGENTS.md automaticamente, e carrega a skill `fiscal-reviewer`. Instruir o agente a revisar o diff desde dev (5 eixos) e salvar relatório em `.agents/reviews/`. Sub-skill `code-simplification` dispara se achar smell.

5. Se reviewer achar problemas → corrige no mesmo terminal do coder, commita, pusha

**REVISÃO (WIP máx 3 cards):** falhar volta pra Em andamento; passar segue pra Teste.

**TESTE:** manual no PDV — venda, recibo, offline/contingência, log middleware. Se falhar, usar sub-skill `debugging-and-error-recovery`.

**CONCLUÍDO:** mergeia PR (dev ← feat/<slug>), deleta branches, volta pra dev.

### Ver diffs no Orca

```bash
orca file open-changed --mode diff      # todos arquivos changed em modo diff
orca file diff <path>                    # diff de um arquivo específico
orca file diff <path> --staged           # diff staged
```

### Ler output de terminal do Orca

```bash
orca terminal list --json                # listar terminais ativos
orca terminal read --terminal <handle>   # ler output de um terminal
```

### Regras de Ouro

| Regra | Detalhe |
|-------|---------|
| 1 task = 1 feature | Nunca misturar duas features no mesmo task |
| Subtasks = tickets | Cada ticket do taskbreaker vira uma subtask no Obsidian PM |
| Só move pra Em andamento | Depois que as subtasks estiverem criadas no task |
| Só move pra Concluído | Depois do merge do PR em dev |
| Branch sempre `feat/` | a partir de dev |
| PR sempre | Nunca mergear direto na dev sem PR |

---

## fiscal-planner — Regras

### Phase 1: Grill (Interview)

Grillar o usuário até todo galho da árvore de decisão estar resolvido. NÃO pular pra solução — questionar o problema primeiro.

**Problem scope:**
- O que exatamente o usuário quer alcançar? (uma frase)
- Quem é afetado? (operador, cliente, gestor, SEFAZ)
- O que acontece hoje sem essa feature? (dor ou gap)
- É feature nova, bugfix, ou refactor?

**Technical constraints:**
- Quais modelos Odoo? (pos.order, pos.session, res.company, product.template, etc.)
- Afeta frontend POS (JS/Owl), backend (Python), ou ambos?
- Afeta o payload do webhook pro middleware?
- Afeta o fluxo offline/contingência?
- Muda o layout do DANFE?

**Edge cases:**
- Múltiplos métodos de pagamento?
- Offline/contingência?
- Middleware unreachable?
- Pagamentos parciais, refunds, cancelamentos?
- Multi-company ou multi-filial?

**Testing:**
- Como saber que funciona? (teste manual no POS, inspeção de log, resposta SEFAZ)
- O que pode quebrar? (riscos de regressão)

### Output do Grill: ADRs

Para cada decisão, registrar ADR lightweight:
```
DEC-XXX: <title>
Context: <por que essa decisão existe>
Decision: <o que foi decidido>
Consequences: <trade-offs, riscos>
```

### Output do Grill: título do task no Obsidian PM

Sugerir título curto (máx 60 chars) — vira nome do card e prefixo da branch (`feat/<slug>`).

Formato: `<type>: <short description>`

Exemplos: `Acréscimo: rateio vOutro no middleware`, `Fechamento: relatório de sangrias`

### Phase 2: Spec

Sintetizar o grill numa spec. Salvar em `.agents/specs/<feature-slug>.md`.

**Antes de escrever:** mapear os seams de teste:
- Preferir seams existentes sobre novos
- Usar o seam mais alto possível (menos seams = melhor, ideal é um)
- Se precisar de seams novos, propor no ponto mais alto

Confirmar com o usuário que os seams batem com a expectativa.

#### Template de Spec

```markdown
# <Feature Name>

## Problem Statement
O problema do ponto de vista do usuário.

## Solution
A solução do ponto de vista do usuário.

## User Stories
1. As a <actor>, I want <feature>, so that <benefit>

## Implementation Decisions
- Quais modelos Odoo estender/modificar
- Campos novos (name, type, constraints)
- Views/XML novos
- Patches JS novos
- Contratos de API (webhook payload shape)
- Schema changes
- Migration

NÃO incluir file paths específicos ou code snippets — envelhecem.
Exceção: snippet de prototype que encode uma decisão mais preciso que prosa (state machine, schema, type shape) — inlinar e marcar que veio de prototype.

## Testing Decisions
- O que faz um bom teste (só testar comportamento externo, não detalhes de implementação)
- Quais seams testar
- Prior art (testes similares no codebase)
- Procedimento de teste manual no POS

## Out of Scope
Coisas explicitamente FORA desta spec.

## Further Notes
Notas adicionais.

## ADRs
- DEC-001: ...
- DEC-002: ...
```

### Phase 3: Tickets (Breakdown)

Quebrar a spec em **tracer-bullet tickets** — cada um é um vertical slice (backend + frontend + view + payload) e demoable sozinho.

**Regras:**
- Cada ticket cabe numa janela de contexto única
- Cada ticket declara **blocking edges** (tickets que devem terminar antes)
- Prefactor primeiro: "Make the change easy, then make the easy change"
- Wide refactors usam expand-contract

Salvar em `.agents/tickets/<feature-slug>/<NN>-<short-title>.md`, numerados de `01` em ordem de dependência.

```markdown
# <NN> — <Ticket Title>

**What to build:** comportamento end-to-end que este ticket faz funcionar.

**Blocked by:** <NN> — <title> ou "None — can start immediately"

**Status:** ready-for-agent

- [ ] Critério de aceitação 1
- [ ] Critério de aceitação 2
```

Apresentar breakdown como lista numerada. Para cada ticket: Title, Blocked by, What it delivers. Perguntar: granularidade OK? Blocking edges corretos? Merge/split? Iterar até aprovação.

---

## fiscal-taskbreaker — Regras

Usado quando a spec já está pronta e precisa ser quebrada em tasks (se o planner já fez Phase 3, não precisa chamar).

### Processo

1. **Ler a spec** de `.agents/specs/<feature-slug>.md`
2. **Explorar o codebase** — entender o estado atual, usar vocabulário de domínio, respeitar ADRs da área. Procurar oportunidades de prefactor.
3. **Draft vertical-slice tasks** — cada task deve ser:
   - **Vertical** — corta backend + view + JS + payload (não horizontal)
   - **Demoable** — dá pra verificar end-to-end quando pronto
   - **One context window** — tamanho pra uma sessão de agente
   - **Blocking edges declarados**
4. **Wide refactors são exceção** — expand-contract, não tracer bullet
5. **Salvar** em `.agents/tickets/<feature-slug>/<NN>-<short-title>.md`
6. **Apresentar** lista numerada (Title, Blocked by, What it delivers) → iterar até aprovação
7. **Checklist pra Obsidian PM (subtasks):**

```markdown
## Checklist
- [ ] 01 — <Task 1 title>
- [ ] 02 — <Task 2 title>
- [ ] 03 — <Task 3 title>
```

Cada título máx 60 chars, auto-explicativo.

8. **Work the frontier** — implementar primeiro qualquer task cujos blockers estão todos done.

---

## fiscal-coder — Regras

### Processo

1. **Ler contexto:** AGENTS.md, spec, ticket, arquivos relevantes do módulo
2. **Implementar ticket por ticket** em ordem de dependência (blockers first):
   1. Ler estado atual dos arquivos
   2. Escrever testes primeiro (TDD) nos seams da spec — red, green, refactor
   3. Implementar — backend primeiro, depois views, depois frontend JS
   4. Rodar typechecking e testes unitários regularmente
   5. Rodar suite completa no final
   6. Commit com conventional commit
   7. Após todos os tickets, rodar `fiscal-reviewer`

### Commit

```
<type>(<scope>): <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `chore`, `docs`
Scopes: `pdv`, `backend`, `middleware`, `receipt`, `contingencia`

Exemplo: `feat(pdv): add troco button to payment screen`

---

## fiscal-reviewer — Regras

### Processo

1. **Pin do fixed point** — commit SHA, branch, tag, `HEAD~5`, etc. Se não especificado, pedir. Capturar `git diff <fixed-point>...HEAD` (three-dot) e `git log <fixed-point>..HEAD --oneline`. Confirmar que resolve e o diff é não-vazio.

2. **Encontrar a spec** — buscar nesta ordem:
   1. Issue references em commit messages (`#123`, `Closes #45`)
   2. `.agents/specs/<feature-slug>.md` matching branch/feature
   3. `.agents/tickets/<feature-slug>/`
   4. Pedir ao usuário. Sem spec, pular eixo Spec.

3. **Ler testes primeiro** — revelam intenção e cobertura. Testes errados/faltantes = código suspeito.

4. **Standards sources** — AGENTS.md, CODING_STANDARDS.md. Carregar smell baseline (Fowler, _Refactoring_ ch.3):
   - **Repo overrides** — standards documentados vencem baseline
   - **Always a judgement call** — cada smell é heurística, não violação hard

5. **Smell baseline (Fowler):**

| Smell | O que é | Como fixar |
|-------|---------|------------|
| **Mysterious Name** | Nome não revela propósito | Renomear |
| **Duplicated Code** | Mesma lógica em múltiplos lugares | Extrair shape compartilhado |
| **Feature Envy** | Método reacha mais dados de outro objeto que os próprios | Mover método |
| **Data Clumps** | Mesmos campos/params viajando juntos | Bundle num tipo |
| **Primitive Obsession** | Primitive/string pra conceito de domínio | Criar tipo pequeno |
| **Repeated Switches** | Mesma switch/if-cascade recursiva | Polimorfismo ou map |
| **Shotgun Surgery** | Uma mudança força edits espalhados | Juntar num módulo |
| **Divergent Change** | Um arquivo editado por motivos não relacionados | Split por concern |
| **Speculative Generality** | Abstração pra needs que não existem | Deletar |
| **Message Chains** | Long a.b().c().d() | Esconder atrás de um método |
| **Middle Man** | Classe que só delega | Cortar, chamar target real |
| **Refused Bequest** | Subclasse ignora maior parte da herança | Usar composição |

### 5 Eixos de Review

#### A — Correctness
- O código faz o que a spec/task diz?
- Edge cases handleados (null, empty, boundary, error paths)?
- Testes verificam o comportamento? Testam a coisa certa?
- Race conditions, off-by-one, state inconsistencies?

**Odoo-specific:**
- [ ] `_order_fields()` syncs all new frontend fields
- [ ] `_loader_params` includes new fields if needed by POS
- [ ] `_load_pos_data_fields()` includes new company fields if needed
- [ ] `_compute_prices()` override doesn't break `amount_total`
- [ ] `sudo()` used where cross-company access is needed
- [ ] `@api.model` on methods callable from JS
- [ ] `store=False` computed fields have `search=` if searchable
- [ ] Webhook payload changes are backward-compatible

#### B — Readability
- Outro engineer entende sem explicação?
- Nomes descritivos e consistentes?
- Control flow straightforward?
- Código bem organizado?
- [ ] `t-esc` used (not `t-raw`) for user data
- [ ] No `position="replace"` that could break DOM (prefer `d-none`)

#### C — Architecture
- Segue patterns existentes ou introduz novo? Se novo, justificado e documentado?
- Module boundaries maintained? Circular deps?
- Nível de abstração apropriado?
- Dependencies flowing in the right direction?

**Code smells (Fowler baseline):** ver checklist acima.

#### D — Security
- User input validated/sanitized em boundaries?
- Secrets fora de code, logs, VCS?
- Auth/authz checked?
- Queries parameterized? Output encoded?
- Novas deps com vulns conhecidas?
- [ ] No hardcoded secrets or tokens
- [ ] No `eval()` or `exec()` in JS
- [ ] No SQL injection vectors
- [ ] Webhook endpoint has auth validation (X-Webhook-Token)
- [ ] Input validation on controller endpoints

#### E — Performance
- N+1 query patterns?
- Unbounded loops ou unconstrained data fetching?
- Sync operations que deveriam ser async?
- Unnecessary re-renders (UI)?
- Missing pagination em list endpoints?

### Severity

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Must fix before merge (vuln, data loss, broken) | Block merge |
| **Important** | Should fix before merge (missing test, wrong abstraction) | Fix before merge |
| **Suggestion** | Consider for improvement (naming, style, optional) | Nice to have |

### Report format

Salvar em `.agents/reviews/<feature-slug>-<date>.md`. Sempre incluir pelo menos uma observação positiva.

```markdown
# Code Review: <feature>

## Review Summary

**Verdict:** APPROVE | REQUEST CHANGES

**Overview:** [1-2 sentences]

### Critical Issues
- [File:line] [Description and recommended fix]

### Important Issues
- [File:line] [Description and recommended fix]

### Suggestions
- [File:line] [Description]

### What's Done Well
- [Positive observation — always include at least one]

### Verification Story
- Tests reviewed: [yes/no, observations]
- Build verified: [yes/no]
- Security checked: [yes/no, observations]
```

---

## Convenções Odoo 18

### Python
- `_inherit = 'model.name'` para extensões
- `_name = 'x.model.name'` para novos modelos
- `@api.model` em métodos chamados do JS via `orm.call`
- `@api.depends` para computed fields
- `sudo()` para acesso cross-company
- `fields.Datetime.now()` para timestamps
- `ir.config_parameter` preferido sobre `os.environ` (sem restart)

### JS (Owl 2)
- `/** @odoo-module */` header obrigatório
- `import { patch } from "@web/core/utils/patch"`
- `patch(ClassName.prototype, { method() { ... } })`
- `super.method(...arguments)` em overrides
- `this.env.services` para ORM, dialog, notification
- RPC: `this.env.services.orm.call("model", "method", [args])`
- `order.payment_ids` (não `payment_ids`)
- `order.get_partner()` (não `get_client()`)
- `order.set_to_invoice(true)` (não `to_invoice = true`)

### XML
- `<record id="..." model="ir.ui.view">` para views novas
- `<field name="inherit_id" ref="..."/>` para herança
- `position="replace"` pode quebrar DOM — preferir `position="attributes" class="d-none"` ou `after`/`before`
- `many2many_checkboxes` widget para M2M em config settings
- Odoo 18 QWeb usa `<strong t-esc="..."/>` não `<strong>t-esc</strong>`

### Webhook
- Novos campos em `_prepare_nfce_payload()` devem ser backward-compatible
- Sempre adicionar campos novos como optional no dict (consumers handle null)
- Todo campo novo do frontend deve estar em `_order_fields()` ou não persiste
- `_loader_params_pos_order()` e `_load_pos_data_fields()` para campos no POS

---

## Pitfalls Consolidados

- **`_order_fields()` é o #1 forgotten sync point** — sempre checar quando adicionar campo no JS order object
- **`_compute_prices()` afeta `amount_total`** que alimenta `_prepare_nfce_payload()` — mudanças aqui cascadeiam
- **`_loader_params`:** campos novos no POS frontend devem estar em `_loader_params_pos_order()` e `_load_pos_data_fields()`
- **`store=False`:** Computed fields sem `store=True` precisam de `search=` para serem searchable
- **`t-esc` vs `t-raw`:** `t-esc` para user data (XSS safety), `t-raw` só para trusted HTML
- **`position="replace"` em XML** pode silenciosamente quebrar outros módulos que dependem do node
- **`os.environ` vs `ir.config_parameter`** — preferir o último para runtime config; env vars precisam restart
- **`sudo()` needed para `partner.credit`** em multi-company setups
- **`many2many_checkboxes` widget** é a escolha correta para M2M em config settings
- **Odoo 18 uses Owl 2** — patches usam `@odoo-module` e `patch()` de `@web/core/utils/patch`
- **Offline contingency** gera chave local — mudanças em `fiscal_contingencia.js` afetam a chave de 44 dígitos
- **Webhook endpoint** é `/api/odoo/webhook` no middleware