# 01 — Modelo: campo amount_acrescimo em report.pos.order

**What to build:**
Criar `_inherit = 'report.pos.order'` no módulo com campo computed `amount_acrescimo`
(Float, store=False) que lê `order_id.x_amount_other_value`. Inclui teste automático
Python que verifica o valor correto via `read()`.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Critérios de aceitação

- [ ] Arquivo `models/report_pos_order.py` criado com a classe `PosOrderReport` herdada
- [ ] Campo `amount_acrescimo` declarado como `Float`, `store=False`, com `_compute_amount_acrescimo`
      que faz `rec.amount_acrescimo = rec.order_id.x_amount_other_value or 0.0`
- [ ] Arquivo registrado em `models/__init__.py`
- [ ] Teste `tests/test_analise_vendas_pdv.py` criado com `TransactionCase`:
  - Cria sessão + 2 pedidos com `x_amount_other_value` diferentes (ex: 5.0 e 10.0)
  - Busca as linhas em `report.pos.order` pelo `order_id`
  - Asserta que `amount_acrescimo` bate com o valor esperado
- [ ] Teste registrado em `tests/__init__.py`
