# 02 — Views XML: search, pivot, graph e list herdados

**What to build:**
Criar o arquivo de views XML do módulo que herda as 4 views do core via XPath mínimo.

> **⚠️ ATENÇÃO — dois campos de desconto distintos, não confundir:**
> - `total_discount` (existe no SQL view do core) = soma dos descontos **por linha de produto**
>   (desconto percentual aplicado no item). É esse que vai como **medida no pivot/graph**.
> - `x_discount_value` (campo do `pos.order`, NÃO está no SQL view) = desconto **global fixo em R$**
>   aplicado na venda inteira. **Não usar aqui** — não existe em `report.pos.order`.
Ao final deste ticket, a tela de análise já mostrará:
- campo de busca por operador (user_id) com filtro "Meu Operador"
- total_discount como medida no pivot e graph
- coluna opcional user_id, total_discount e amount_acrescimo na list view

**Blocked by:** 01 — Modelo (amount_acrescimo deve existir antes de referenciar no XML)

**Status:** ready-for-agent

## Critérios de aceitação

### Search view (`view_report_pos_order_search` herdada)
- [ ] `<field name="user_id"/>` adicionado (autocomplete many2one)
- [ ] Filtro `my_operator` com `domain="[('user_id','=',uid)]"` e string "Meu Operador"
      inserido antes do `<separator/>` de Group By
- [ ] Filtro pré-existente "User" (Group By) preservado — não remover

### Pivot view (`view_report_pos_order_pivot` herdada)
- [ ] `<field name="total_discount" type="measure"/>` adicionado via XPath after `price_total`

### Graph view (`view_report_pos_order_graph` herdada)
- [ ] `<field name="total_discount" type="measure"/>` adicionado via XPath

### List view (`report_pos_order_view_tree` herdada)
- [ ] `user_id` adicionado como `optional="show"`
- [ ] `total_discount` adicionado como `optional="show"`
- [ ] `amount_acrescimo` adicionado como `optional="hide"`

### Arquivo
- [ ] Arquivo criado em `views/pos_order_report_analise_views.xml`
- [ ] Registrado em `__manifest__.py` na chave `data`
