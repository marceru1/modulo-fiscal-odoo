# 03 — Action: adicionar list ao view_mode

**What to build:**
Herdar a action `action_report_pos_order_all` do core para adicionar `list` ao `view_mode`,
tornando a view de lista acessível a partir da tela de análise.

**Blocked by:** 02 — Views XML (a list view deve estar configurada antes de habilitar o modo)

**Status:** ready-for-agent

## Critérios de aceitação

- [ ] No mesmo arquivo `views/pos_order_report_analise_views.xml` (ticket 02), adicionar
      record herdando `point_of_sale.action_report_pos_order_all`
- [ ] Campo `view_mode` sobrescrito para `graph,pivot,list`
- [ ] Verificar (inspeção manual ou teste de XML id) que o record tem `inherit_id` correto
      apontando para `point_of_sale.action_report_pos_order_all`
- [ ] Smoke test manual: abrir Relatórios → Pedidos e confirmar que aparecem 3 abas
      (gráfico, pivot, lista)

## Notas de implementação

A herança de `ir.actions.act_window` no Odoo 18 pode ser feita declarando o mesmo
`id` externo com `noupdate="1"` OU usando um record separado com `inherit_id`. Verificar
qual mecanismo o Odoo 18 suporta para actions (não é o mesmo que ir.ui.view).

> **Atenção (source-driven-development):** Antes de implementar, verificar na doc/código
> do Odoo 18 como se herda `ir.actions.act_window`. A forma canônica pode ser sobrescrever
> o campo diretamente num record com o mesmo external ID (sem `inherit_id`), usando
> `noupdate="0"`. Citar a fonte e flagar se não verificado.
