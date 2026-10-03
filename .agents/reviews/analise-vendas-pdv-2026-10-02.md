# Code Review: analise-vendas-pdv

**Data:** 2026-10-02  
**Branch:** analise-vendas-pdv  
**Fixed point:** HEAD (código gerado nesta sessão — sem commits anteriores)  
**Spec:** `.agents/specs/analise-vendas-pdv.md`  
**Code Report:** `.agents/code-reports/analise-vendas-pdv.md`

---

## Review Summary

**Verdict:** REQUEST CHANGES

2 achados **Critical** foram corrigidos pelo reviewer em-sessão (bugs de tooling, não de lógica).
1 achado **Important** restante no teste requer atenção antes de merge.
Demais pontos são Suggestions.

### Positivo

O núcleo da implementação é sólido: a herança `_inherit = 'report.pos.order'` com `store=False` é exatamente o padrão correto para expor dados derivados sem tocar na SQL view. As views XML são limpas, com XPaths mínimos e sem nenhuma reescrita destrutiva — risco de regressão em upgrade do core é baixo. A separação `total_discount` (SQL, por linha) × `x_discount_value` (global fixo) foi respeitada conforme a spec e os ADRs.

---

## Achados por Eixo

### A — Correctness

#### 🔴 CRITICAL (corrigido em-sessão): `models/__init__.py` — linha colada sem newline

**O que era:**
```python
from . import res_config_settingsfrom . import report_pos_order
```

**Causa:** `echo >> arquivo` em macOS concatena ao final sem newline se o arquivo não termina com `\n`. Isso causa `SyntaxError` (ou silenciosamente ignora a importação) — `PosOrderReport` nunca seria registrado no Odoo.

**Correção aplicada:** linha separada via script Python in-place. ✅

---

#### 🔴 CRITICAL (corrigido em-sessão): `__manifest__.py` — view XML não registrada

**O que era:** `views/pos_order_report_analise_views.xml` não constava na chave `data` do manifest. O `sed` com `position="after"` no macOS não injetou a linha. Nenhuma das views XML (search, pivot, graph, list, action override) teria carregado.

**Correção aplicada:** `pos_order_report_analise_views.xml` inserido na seção `data`. ✅

---

#### 🟡 IMPORTANT: Teste não verifica que o `report.pos.order` de fato tem linhas

**Arquivo:** `tests/test_analise_vendas_pdv.py`, linhas 66–74.

```python
report1_lines = self.env['report.pos.order'].search([('order_id', '=', order1.id)])
for line in report1_lines:
    self.assertEqual(line.amount_acrescimo, 5.0, ...)
```

**Problema:** Se `report1_lines` for vazio (o que pode acontecer porque o `pos.order` criado no teste está em estado `draft`, e o SQL view do core não projeta linhas de pedidos não-pagos dependendo do `JOIN` com `pos_session`), o `for` itera sobre nada — o `assertEqual` nunca executa e o teste passa verde **sem testar coisa alguma**.

**Fix necessário:** Adicionar asserção prévia:
```python
self.assertTrue(report1_lines, "report.pos.order deve conter linhas para order1")
self.assertTrue(report2_lines, "report.pos.order deve conter linhas para order2")
```
E/ou fazer `action_pos_session_close()` + verificar estado do pedido antes de buscar no report.

**Severity:** Important — o teste existe mas pode não exercitar o código.

---

#### 🟡 IMPORTANT: `action_pos_session_open()` em `setUp` — side effects em paralelo

**Arquivo:** `tests/test_analise_vendas_pdv.py`, linha 31.

`action_pos_session_open()` cria um `account.bank.statement` e pode lançar exceções se o diário de caixa não estiver configurado. Em CI com múltiplos workers pode haver lock no banco. Padrão visto em `test_recebimento.py` (arquivo existente) é criar o diário explicitamente. Verificar se os outros testes do módulo fazem `action_pos_session_open()` — se sim, o padrão já está estabelecido; se não, é mais seguro criar os pedidos sem sessão aberta (o SQL view usa `LEFT JOIN pos_session`, então funciona sem estado fechado).

**Severity:** Important — pode causar flaky test em CI.

---

### B — Readability

#### 🔵 Suggestion: `report_pos_order.py` — campo `readonly=True` redundante

`readonly=True` em campo computed `store=False` é implícito no Odoo (campos computed sem setter são sempre readonly). A linha não prejudica, mas gera ruído.

```python
# Atual
amount_acrescimo = fields.Float(
    string='Acréscimo',
    compute='_compute_amount_acrescimo',
    store=False,
    readonly=True   # ← redundante
)
```

**Severity:** Suggestion.

---

#### 🔵 Suggestion: XML — comentário do action override poderia ser mais preciso

Linha 73 do XML:
```xml
<!-- No Odoo, para adicionar um modo de visão novo (list), podemos usar o ID externo para sobrescrever -->
```

A afirmação é verdadeira para `ir.actions.act_window` — diferente de `ir.ui.view`, que exige `inherit_id`. O comentário está tecnicamente correto mas poderia mencionar explicitamente que `ir.actions` não usa `inherit_id` para não confundir quem ler depois.

**Severity:** Suggestion.

---

### C — Architecture

#### ✅ DEC-001 respeitado
O SQL view do core não foi tocado. Confirmado lendo `pos_order_report.py` do core — nenhum `_select()` herdado no módulo.

#### ✅ DEC-002 respeitado
Todas as views usam `inherit_id` + XPath mínimo. Nenhuma view foi recriada do zero.

#### ✅ DEC-003 respeitado
`amount_acrescimo` é `store=False` — não cria coluna no banco, não altera o SQL view.

#### ✅ DEC-005 respeitado
A action usa o external ID original `point_of_sale.action_report_pos_order_all` para sobrescrever apenas `view_mode`. Este é o mecanismo padrão do Odoo para `ir.actions.act_window` (sem `inherit_id` — actions não suportam o mecanismo de herança de views).

#### 🔵 Suggestion: `@api.depends` ausente no compute

```python
def _compute_amount_acrescimo(self):
    for rec in self:
        rec.amount_acrescimo = rec.order_id.x_amount_other_value or 0.0
```

Sem `@api.depends('order_id.x_amount_other_value')`, o Odoo não sabe quando invalidar o cache do campo computed. Para `store=False` em SQL views (`_auto=False`), o Odoo normalmente recalcula sempre que o record é lido — então o comportamento em runtime é correto. Mas o decorador é boas práticas e evita warnings no log do Odoo:

```python
@api.depends('order_id.x_amount_other_value')
def _compute_amount_acrescimo(self):
    ...
```

**Severity:** Suggestion (não quebra, mas gera log warnings em Odoo 18).

---

### D — Security

#### ✅ Sem novos endpoints, sem SQL injection vectors
A feature é 100% declarativa (Python field + XML). Nenhum controller criado. O campo `amount_acrescimo` lê via ORM — sem SQL raw.

#### ✅ Sem secrets, sem `eval()`/`exec()`

---

### E — Performance

#### ✅ Sem N+1 no compute
O compute itera sobre `self` e acessa `rec.order_id.x_amount_other_value` — o Odoo faz prefetch automático de `order_id` quando o campo é Many2one. Sem N+1 para conjuntos razoáveis de registros.

#### 🔵 Suggestion: `search()` no teste sem `limit`
`self.env['report.pos.order'].search([('order_id', '=', order1.id)])` — sem `limit`, pode retornar muitas linhas se o banco de teste tiver dados residuais de outros testes rodando na mesma transaction. Adicionar `limit=100` ou usar IDs isolados é prudente.

---

## Checklist Odoo-specific

- [x] SQL view do core intacto
- [x] `store=False` no campo computed — sem coluna nova no banco
- [ ] `@api.depends` ausente — **Suggestion** (adicionar antes de merge)
- [x] `t-esc` / `t-raw` — N/A (sem templates Owl)
- [x] Sem `position="replace"` nas views XML
- [x] `optional="hide"` no `amount_acrescimo` na list view
- [x] Filtro "Meu Operador" é opt-in (DEC-004)
- [ ] Teste não asserta que `report_lines` não está vazio — **Important**
- [x] `__manifest__.py` com a view registrada (corrigido em-sessão)
- [x] `models/__init__.py` com newline correto (corrigido em-sessão)

---

## Ações antes de merge

| # | Severity | Arquivo | Ação |
|---|----------|---------|------|
| 1 | Important | `tests/test_analise_vendas_pdv.py` | Adicionar `assertTrue(report1_lines, ...)` antes do `for` |
| 2 | Important | `tests/test_analise_vendas_pdv.py` | Verificar se pedido em `draft` aparece no report SQL ou se precisa de `action_pos_session_close()` |
| 3 | Suggestion | `models/report_pos_order.py` | Adicionar `@api.depends('order_id.x_amount_other_value')` |
| 4 | Suggestion | `models/report_pos_order.py` | Remover `readonly=True` redundante |

---

## Bugs corrigidos pelo reviewer (em-sessão)

| Bug | Arquivo | Fix |
|-----|---------|-----|
| `res_config_settingsfrom . import report_pos_order` sem newline | `models/__init__.py` | Linha separada via script Python |
| `pos_order_report_analise_views.xml` não constava no manifest | `__manifest__.py` | Inserido na chave `data` via `replace_file_content` |
