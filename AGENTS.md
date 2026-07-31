# AGENTS.md — Workspace Odoo 18 Fiscal Module

## Propósito

Este workspace contém o módulo customizado `meu_modulo_fiscal` para Odoo 18, que adiciona controle tributário (NCM, CFOP, PIS/COFINS) e integra o PDV com Middleware de NFC-e (Focus NFe).

## Pipeline de Desenvolvimento

O fluxo de trabalho usa 3 agentes em terminais separados:

```
Terminal 1 (agy)               Terminal 2 (deepseek)      Terminal 3 (kimi)
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

## Skills Hermes

| Skill | Agente | Uso |
|-------|--------|-----|
| `fiscal-planner` | agy (atlas) | Grilla a task, produz spec em `.agents/specs/` |
| `fiscal-taskbreaker` | agy (atlas) | Quebra spec em tasks em `.agents/tickets/` |
| `fiscal-coder` | deepseek-v4-flash | Lê as tasks e implementa uma por uma |
| `fiscal-reviewer` | kimi-2.7 | Revisa spec compliance + code quality |

## Estrutura de Arquivos

```
my_addons/
├── AGENTS.md              ← este arquivo
├── .agents/
│   ├── specs/             ← specs geradas pelo planner
│   │   └── <feature-slug>.md
│   ├── tickets/           ← tasks quebradas pelo taskbreaker
│   │   └── <feature-slug>/
│   │       ├── 01-<title>.md
│   │       └── 02-<title>.md
│   ├── reviews/           ← relatórios de review
│   │   └── <feature-slug>-<date>.md
│   ├── planner.md         ← skill: grill + spec
│   ├── taskbreaker.md     ← skill: quebra spec em tasks
│   ├── coder.md           ← skill: implementação
│   └── reviewer.md        ← skill: revisão 2 eixos
└── meu_modulo_fiscal/     ← o módulo Odoo
```

## Convenções Odoo 18

### Python
- `_inherit = 'model.name'` para extensões
- `_name = 'x.model.name'` para novos modelos
- `@api.model` em métodos chamados do JS via `orm.call`
- `sudo()` para acesso cross-company
- `ir.config_parameter` preferido sobre `os.environ` para config runtime

### JS (Owl 2)
- `/** @odoo-module */` header obrigatório
- `patch()` de `@web/core/utils/patch`
- `order.payment_ids` (não `payment_ids`)
- `order.get_partner()` (não `get_client()`)
- `order.set_to_invoice(true)` (não `to_invoice = true`)

### XML
- `position="replace"` pode quebrar DOM — preferir `d-none` ou `after`/`before`
- `many2many_checkboxes` widget para M2M em config settings

### Webhook
- Novos campos em `_prepare_nfce_payload()` devem ser backward-compatible
- Todo campo novo do frontend deve estar em `_order_fields()`
- `_loader_params_pos_order()` e `_load_pos_data_fields()` para campos no POS

## Commits

Formato: `<type>(<scope>): <desc>`

Types: feat, fix, refactor, chore, docs
Scopes: pdv, backend, middleware, receipt, contingencia
