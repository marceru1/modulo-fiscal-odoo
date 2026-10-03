# Análise de Vendas PDV — Melhorias na Tela Orders Analysis

## Problem Statement

A tela "Análise de Pedidos" do PDV (Relatórios → Pedidos) não permite filtrar por operador
de caixa nem visualizar desconto e acréscimo por venda. O gestor não consegue responder
"quanto fulano vendeu hoje" ou "qual o total de descontos dados nessa sessão" sem exportar
dados manualmente.

## Solution

Melhorar a tela existente `action_report_pos_order_all` (modelo `report.pos.order`) herdando
suas views (search, pivot, graph) e adicionando:

1. **Filtro por operador** — campo de busca livre com autocomplete em `user_id` + filtro
   pré-definido "Meu Operador" (aplica `user_id = uid` ao abrir).
2. **Desconto como medida no pivot e graph** — expor `total_discount` (já calculado no
   SQL view do core) como medida disponível.
3. **Acréscimo na view de lista** — adicionar campo `amount_acrescimo` (related para
   `order_id.x_amount_other_value`) visível opcionalmente na list view.
4. **View de lista acessível** — adicionar `list` ao `view_mode` da action herdada,
   permitindo drill-down linha a linha.

A implementação herda todas as views do core via `inherit_id` e sobrescreve apenas a action
via `inherit_id`+`view_mode`. Nenhuma view do core é recriada do zero. O SQL view do
`report.pos.order` não é alterado.

## User Stories

1. As a **gestor**, I want to filter Orders Analysis by cashier (user_id), so that I can
   see how much each operator sold in a given period.
2. As a **gestor**, I want a quick "My Operator" filter, so that I can instantly scope the
   report to my own sales without typing my name.
3. As a **gestor**, I want total_discount exposed as a pivot measure, so that I can compare
   discount totals across products, categories, or periods in the pivot/graph.
4. As a **gestor**, I want to see the surcharge (acréscimo) per order in list view, so that
   I can audit individual orders that had vOutro applied.
5. As a **gestor**, I want to switch to list view from the same action, so that I can
   drill down from pivot to individual order lines.

## Implementation Decisions

### Modelo

- **NÃO alterar o SQL view** do core (`report.pos.order`). Mantém-se `_auto = False`
  sem novos SELECTs.
- Criar um `_inherit = 'report.pos.order'` no módulo com **um único campo novo**:
  - `amount_acrescimo`: `Float`, `store=False`, `compute=_compute_amount_acrescimo`,
    lê `order_id.x_amount_other_value`. Campo computed sem store — não é agregável em
    pivot/graph (sem SQL backing), mas é visível na list view.
- `total_discount` já existe no SQL view — basta expô-lo como medida no XML.

### Views

- **Search view herdada** (`view_report_pos_order_search`): adicionar `<field name="user_id"/>`
  (campo de busca com autocomplete) e filtro pré-definido:
  ```
  <filter name="my_operator" string="Meu Operador" domain="[('user_id','=',uid)]"/>
  ```
- **Pivot view herdada** (`view_report_pos_order_pivot`): adicionar
  `<field name="total_discount" type="measure"/>` via XPath.
- **Graph view herdada** (`view_report_pos_order_graph`): adicionar
  `<field name="total_discount" type="measure"/>` via XPath (ficará disponível no
  selector de medidas do gráfico).
- **List view herdada** (`report_pos_order_view_tree`): adicionar campos opcionais
  `user_id`, `total_discount`, `amount_acrescimo` via XPath.
- **Action herdada** (`action_report_pos_order_all`): sobrescrever `view_mode` para
  `graph,pivot,list`.

### Sem JS / Sem frontend POS

Esta feature é 100% backend Odoo (Python + XML). Nenhum componente Owl/JS é criado.

### Backward compatibility

- O filtro "Meu Operador" NÃO é ativado por padrão no `context` da action — seria
  intrusivo para gestor que quer ver todos os operadores. É opt-in.
- `amount_acrescimo` é `optional="hide"` na list — não aparece a não ser que o
  usuário ative.

## Testing Decisions

### Seam de teste

**Um único seam:** o modelo `report.pos.order` herdado com o campo `amount_acrescimo`.
Verificar via `read()` que o campo retorna `order_id.x_amount_other_value` corretamente.

Outros aspectos (search view, pivot, action) são puramente declarativos (XML) e verificados
por inspeção de XML id + smoke test manual no POS backend.

### Testes automáticos (Python)

- `test_analise_vendas_pdv.py`: cria 2 `pos.order` com `x_amount_other_value` distintos,
  busca as linhas correspondentes em `report.pos.order`, verifica que
  `amount_acrescimo` reflete o valor correto.
- Não testar `total_discount` via Python (já coberto pelos testes do core do Odoo).

### Teste manual no backend

1. Abrir Ponto de Venda → Relatórios → Pedidos.
2. Na barra de busca, digitar nome de um operador → confirmar que o pivot/graph filtra.
3. Clicar em "Meu Operador" → confirmar que filtra pelo usuário logado.
4. No pivot: abrir medidas → confirmar que "Total Discount" aparece e é selecionável.
5. Trocar para list view → confirmar que a view de lista carrega.
6. Na lista, ativar coluna opcional "Acréscimo" → confirmar que exibe o valor de
   `x_amount_other_value` do pedido.

## Out of Scope

- Alterar o SQL view `report.pos.order` do core.
- Adicionar `x_amount_other_value` como medida agregável no pivot (exigiria SQL view
  própria — DEC-003 / Decisão 3).
- Status fiscal / contingência NFC-e na tela de análise.
- Cancelamento de cupom.
- Tela nova ou relatório separado.
- Qualquer componente JS/Owl.

## Further Notes

- `total_discount` no SQL view é desconto **por linha** (% de linha), não o
  `x_discount_value` (desconto global fixo do pos.order). No pivot agrupado por pedido,
  a soma de `total_discount` das linhas do pedido equivale ao desconto total da venda.
  Isso é suficiente para análise gerencial.
- `amount_acrescimo` via related não é sorted/searchable no servidor sem `search=`.
  Para esta versão, optional na lista é suficiente — sem search server-side.

## ADRs

### DEC-001: Não alterar o SQL view do core

**Context:** `report.pos.order` usa `_auto=False` e a view SQL do core é shared entre
todos os módulos que herdam `point_of_sale`. Alterar o SELECT exigiria chamar `init()`
com SQL próprio, o que pode colidir com upgrades do core.

**Decision:** O módulo não altera o SQL view. Campos novos que exigem SQL backing ficam
fora de escopo desta feature.

**Consequences:** `x_amount_other_value` (acréscimo) não é agregável no pivot. Fica
restrito à list view via computed/related. Aceitável para o escopo atual.

---

### DEC-002: Usar inherited views (XPath) em vez de recriar

**Context:** Recriar search/pivot/graph do zero duplica código e quebra ao atualizar o core.

**Decision:** Todos os XML são `inherit_id` das views do core, com XPath mínimo.

**Consequences:** Upgrades do core preservam as melhorias. Risco de XPath quebrar se o
core reestruturar o XML — aceitável e fácil de fixar.

---

### DEC-003: Acréscimo só na list view (computed, sem store)

**Context:** Para aparecer no pivot, `amount_acrescimo` precisaria de coluna no SQL view
(DEC-001 proíbe) ou de SQL view própria (escopo aumentaria significativamente).

**Decision:** `amount_acrescimo` é campo computed `store=False`, visível apenas na list.

**Consequences:** Não é filtrável/sortable no servidor. Para pivot, o acréscimo não
aparece. Gestor que precisa agregar acréscimos por período terá que exportar a lista.
Trade-off aceito pelo usuário.

---

### DEC-004: Filtro "Meu Operador" como opt-in (não default)

**Context:** A action atual tem `context={'group_by':[], 'search_default_not_cancelled': 1}`.
Adicionar `search_default_my_operator: 1` ao context tornaria o filtro ativo por padrão,
o que é intrusivo para gestores que querem ver todos os operadores.

**Decision:** O filtro "Meu Operador" existe na search view mas não é ativado por padrão.

**Consequences:** O operador de caixa precisa clicar no filtro para ver apenas suas vendas.
Aceitável — é uma tela de análise, não de operação.

---

### DEC-005: View de lista via view_mode herdado na action

**Context:** A list view `report_pos_order_view_tree` já existe no core. Para acessá-la
é necessário que a action inclua `list` em `view_mode`.

**Decision:** Herdar a action e sobrescrever `view_mode` para `graph,pivot,list`.

**Consequences:** O usuário vê 3 abas na tela de análise. Sem risco de regressão —
a list view já existe e apenas estava inacessível via esta action.
