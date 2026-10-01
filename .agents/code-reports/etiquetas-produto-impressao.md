# Code Report — Etiquetas de Produto (Impressão pelo Estoque)

**Feature:** `etiquetas-produto-impressao`
**Branch:** `marceru1/etiquetas-produto-impressao`
**Spec:** `.agents/specs/etiquetas-produto-impressao.md`
**Tickets:** `.agents/tickets/etiquetas-produto-impressao/01..05`

---

## 1. Resumo

Impressão de etiquetas de preço/código de barras direto do Odoo, sem BarTender.

Fluxo entregue: **Inventário › Produtos › Etiquetas** abre a lista de
`product.template`; o operador marca os produtos, usa **Imprimir Etiquetas** na
toolbar, e o wizard abre com **uma linha por produto** (produto + quantidade —
quantidade POR PRODUTO, não global). Escolhido o formato (Bijuteria 34,8×20 mm ou
Confecção 35×60 mm), o PDF QWeb é gerado no tamanho exato da etiqueta e abre no
navegador para Ctrl+P.

Dois layouts, com paridade com o BarTender:
- **Bijuteria (34,8×20 mm):** nome · referência · Code128 do EAN · dígitos · preço.
- **Confecção (35×60 mm):** idem, preço maior, rodapé `@lojas20mais_itacoatiara`.

## 2. Arquivos

### Novos

| Arquivo | Ticket |
|---|---|
| `meu_modulo_fiscal/wizard/__init__.py` | 01 |
| `meu_modulo_fiscal/wizard/product_label_layout.py` | 01 |
| `meu_modulo_fiscal/report/__init__.py` | 02 |
| `meu_modulo_fiscal/report/etiqueta_reports.py` | 02 |
| `meu_modulo_fiscal/report/etiquetas_reports.xml` | 02 |
| `meu_modulo_fiscal/report/etiqueta_styles.xml` | 03 |
| `meu_modulo_fiscal/report/etiqueta_bijuteria_template.xml` | 03 |
| `meu_modulo_fiscal/report/etiqueta_confeccao_template.xml` | 03 |
| `meu_modulo_fiscal/views/etiquetas_wizard_views.xml` | 04 |
| `meu_modulo_fiscal/views/etiquetas_menu_views.xml` | 04 |
| `meu_modulo_fiscal/tests/test_etiquetas_wizard.py` | 01 / 05 |
| `.agents/tests/test_etiquetas_xmlids.py` | 05 |

### Alterados

| Arquivo | O que mudou |
|---|---|
| `meu_modulo_fiscal/__init__.py` | importa `wizard` e `report` |
| `meu_modulo_fiscal/__manifest__.py` | `data`: 6 XML novos, na ordem reports → templates → views |
| `meu_modulo_fiscal/security/ir.model.access.csv` | ACL de `x.label.line` para `base.group_user` |
| `meu_modulo_fiscal/tests/__init__.py` | importa `test_etiquetas_wizard` |

Nenhum arquivo de PDV, webhook, middleware, `recurso_variantes.py` ou
contingência foi tocado (spec, "Sem alterações").

## 3. Decisões técnicas

### 3.1 Quantidade POR PRODUTO via One2many próprio

O core só tem `custom_quantity` (um valor global) e `_prepare_report_data()`
monta `{produto: custom_quantity}`. Para o requisito da loja, o wizard ganhou
`x_line_ids` → novo modelo transiente **`x.label.line`** (`product_id` +
`quantity`, com constraint de quantidade > 0), e o override monta
`quantity_by_product` linha a linha. O mesmo produto em duas linhas **soma**
(testado).

### 3.2 `x_label_format` sem default de modelo — de propósito

O modelo `product.label.layout` é compartilhado: `stock.picking`, `mrp.production`
e `stock.picking.batch` criam esse wizard e chamam `process()` para imprimir as
etiquetas **do core**. Um `default` ou `required=True` no modelo faria esses
fluxos caírem no nosso caminho e imprimir a etiqueta errada.

Por isso: sem default, sem `required` no modelo; `required="1"` só na nossa view;
nosso atalho (`server action`) passa `x_label_format='bijuteria'` explicitamente.
`_prepare_report_data()` e `process()` fazem `if not self.x_label_format: return
super()`. Há teste de regressão para isso
(`test_fluxo_do_core_intacto_sem_x_label_format`).

### 3.3 View `primary` própria, não herança da form do core

Mesmo motivo do 3.2: herdar `product.product_label_layout_form` mostraria
`x_label_format`/`x_line_ids` nos wizards de Estoque/MRP. A nossa view é
`mode="primary"` com `priority=99`, então a do core continua sendo a form padrão
do modelo para quem abrir o wizard sem fixar `view`.

### 3.4 Variante resolvida no wizard, relatório roda em `product.product`

A seleção na lista é de `product.template`; o `barcode` (EAN-13 gerado por
`recurso_variantes.py`) vive em `product.product`. O wizard resolve
`product_variant_id` (primeira variante ativa) e o `data` trafega em
`active_model='product.product'` — igual ao core, que também só aceita tipos
nativos no `data` (ele passa por JSON no caminho da action).

### 3.5 AbstractModel `report.<name>` — necessário, não decorativo

`report_action(None, data=...)` passa `docids=None`; sem um modelo de relatório,
o fallback de `_get_rendering_context` montaria `docs` vazio e o PDF sairia em
branco. Por isso existem `report.meu_modulo_fiscal.report_etiqueta_{bijuteria,confeccao}`
(inheritando um `report_etiqueta` comum), que resolvem os IDs do `data` em
registros — exatamente o padrão de `product/report/product_label_report.py`.
Isso também torna o contrato testável em Python puro, sem wkhtmltopdf.

`_get_report_values` normaliza as chaves para `int` antes do lookup: no fluxo
real elas chegam como string (JSON) e em teste direto como int.

### 3.6 Reset de `body` em template próprio, não em asset

O relatório do Odoo renderiza dentro de `body.container-fluid`, cujo padding
(~3 mm de cada lado) deslocaria a etiqueta dentro de uma página de 34,8 mm. O
reset (`margin/padding: 0`) foi posto num `<style>` **dentro do template**
(`etiqueta_styles`), não em `web.report_assets_common`. Motivo: aquele bundle é
compartilhado por **todos** os relatórios do Odoo — um reset de `body` ali
vazaria para fatura, recibo, fechamento etc. (Shotgun Surgery). Como está, o
reset vale só para o documento que o contém. O core faz o mesmo por outro
caminho (margens negativas em `.o_label_sheet`), que aqui seria número mágico.

Deliberadamente **sem `overflow: hidden`** no reset: no wkhtmltopdf o documento
é uma página longa recortada em fatias, e esconder o overflow do root cortaria
as páginas seguintes. O `overflow: hidden` fica só na etiqueta.

### 3.7 Quebra de página: `+ .x_etiqueta`, não `page-break-before` em todas

O core põe `page-break-before: always` em **toda** `.o_label_sheet`, inclusive a
primeira — receita para página em branco no início dependendo da versão do
wkhtmltopdf. Aqui a quebra é `.x_etiqueta + .x_etiqueta { page-break-before:
always }` (seletor de irmão adjacente, CSS2.1): quebra só **entre** etiquetas, a
primeira nunca gera página extra.

### 3.8 Preço, barcode e nome

- **Preço:** widget `monetary` com `product.currency_id` (→ `R$ 49,90`), em vez
  do `format(...).replace(...)` sugerido no ticket 03. Aquele encadeamento de
  `replace` quebra com separador de milhar e ignora a moeda da empresa.
- **Barcode:** widget nativo `barcode`, `symbology='Code128'` (a spec pede
  Code128; o core usa `auto`), `quiet=0` como o `report_productlabel_dymo`.
  `width`/`height` intrínsecos foram escolhidos com a **mesma proporção** do
  `img_style` (930×180 para 31×6 mm; 930×420 para 31×14 mm) — proporção
  diferente esticaria as barras e prejudicaria a leitura.
- **`t-out` em vez de `t-field`:** a spec cita `t-field` com `widget="barcode"`,
  mas manda seguir o `report_productlabel_dymo` do core, que usa
  `t-out` + `t-options` para barcode e preço. Segui o core (forma comprovada,
  mesma saída HTML) e mantive o template internamente consistente.

### 3.9 Barcode ausente → omite (não avisa)

Spec, "Further Notes", deixou a escolha em aberto. Optei por **omitir** o bloco
de código de barras e os dígitos quando `product.barcode` é vazio
(`t-if="barcode"`), que é o comportamento do core. Nome, referência e preço
continuam saindo — a etiqueta segue utilizável. Sem aviso na tela para não
interromper um lote de impressão.

## 4. Desvios dos tickets (spec prevaleceu)

| Ticket | Ticket dizia | Fiz | Por quê |
|---|---|---|---|
| 03 | `default_code` no **template A** (Bijuteria) | Incluído, condicional (`t-if`) | DEC-003 diz "exibir quando preenchido, omitir quando vazio". A lista da spec para o Layout A não o cita, mas também não o proíbe. **Ponto de verificação visual:** 20 mm é apertado — se cortar, remover esta linha do A. |
| 04 | menu aponta para `action_etiquetas_wizard` (o wizard direto) | menu aponta para `action_etiquetas_produtos` (lista de produtos) | A spec pede "act_window abrindo a **list view** de product.template com botão Imprimir Etiquetas", e a user story 1 é "selecionar produtos de uma lista". Abrir o wizard direto do menu daria modal vazio → `UserError` imediato. |
| 04 | herdar a view do wizard | view `primary` própria | Ver 3.3. |
| 02 | `model='product.product'` no report | mantido | Consistente com 3.4. |

## 5. Testes

### Puderam ser executados aqui

```bash
python3 .agents/tests/test_etiquetas_xmlids.py
✓ 2 reports: wizard → ir.actions.report → template → AbstractModel
✓ refs/t-calls resolvem em 6 arquivos XML
✓ xml_id da feature etiquetas-produto-impressao consistentes
```

Também rodado: `py_compile` em todos os `.py` novos; `ast.literal_eval` no
manifest; `csv.DictReader` na ACL; **parse lxml estrito** em todos os XML novos.

> O parse lxml pegou um erro real: `--page-width` **dentro de um comentário XML**
> é inválido (`Comment must not contain '--'`). Corrigido. É exatamente a classe
> de erro do pitfall do skill (XML malformado derruba o bundle/instalação).

### Escritos, NÃO executados aqui (Odoo não roda nesta máquina)

`meu_modulo_fiscal/tests/test_etiquetas_wizard.py` — sem Postgres e o venv local
não tem `odoo` instalado, então a suíte do Odoo não sobe. Cobrem:

- **Seam 1:** xml_id por formato; `quantity_by_product` por produto; `UserError`
  sem produtos; quantidade ≤ 0; produto sem EAN/`default_code`; mesmo produto em
  duas linhas somando; **regressão** do fluxo do core sem `x_label_format`.
- **Contrato do relatório:** `_get_report_values()` resolve IDs em registros e
  ignora ID órfão.
- **Seam 2 (smoke):** render do PDF dos dois layouts, `@tagged('post_install',
  '-at_install')` — precisa de wkhtmltopdf.

```bash
# no container com Odoo + Postgres:
odoo -d <db> -u meu_modulo_fiscal --test-enable --test-tags /meu_modulo_fiscal
```

## 6. Pontos de atenção para o reviewer

**Alta prioridade — precisam de ambiente real:**

1. **Página em branco / overflow de página.** O maior risco da feature. Se
   aparecer folga ou página extra, o ponto de ajuste é a altura/largura em mm em
   `etiqueta_styles.xml` (`.x_etiqueta_bijuteria` / `_confeccao`). Não consegui
   medir o PDF renderizado — validar no ticket 05.
2. **Rodapé Instagram no layout Confecção.** Usei `<i class="fa fa-instagram"/>`
   (Font Awesome está em `web.report_assets_common`, confirmado no manifest do
   `web`). **Não verifiquei se o glifo renderiza no PDF** — webfont em
   wkhtmltopdf é o ponto frágil. Se sair quadrado/tofu, trocar por SVG inline.
   O texto `@lojas20mais_itacoatiara` sai de qualquer forma.
3. **`quiet=0` no Code128.** Segue o core, mas remove a *quiet zone* — se a
   leitora da loja falhar na etiqueta, é o primeiro suspeito (trocar para
   `quiet: 1` e reduzir a largura do `img_style`).
4. **Dimensão do papel no driver Elgin.** Confirmar que o Ctrl+P detecta
   34,8×20 e 35×60 (paperformat `custom`, `dpi=96`, `disable_shrinking=True` —
   os três são candidatos a ajuste se a escala sair errada).
5. **`default_code` no layout Bijuteria** (seção 4) — verificar se cabe nos
   20 mm sem cortar o preço.

**Média:**

6. **`x.label.line` com `ondelete='cascade'` em `product_id`.** Excluir um
   `product.template` apaga linhas transientes pendentes. Inofensivo (são
   transientes), mas é o tipo de coisa que merece um segundo olhar.
7. **Server action cria o wizard com `x_label_format='bijuteria'` fixo.** Se o
   formato mais usado virar Confecção, é um lugar só para trocar — ou vale ler
   de um `ir.config_parameter` numa próxima iteração.
8. **`priority=99` na view do wizard.** Depende de o core manter a form dele com
   priority menor (default 16) para continuar sendo a padrão do modelo. Se o
   core mudar, os wizards de Estoque/MRP abrem com a nossa view — daí os campos
   da loja apareceriam lá (mas o `process()` continuaria caindo no `super()`,
   porque `x_label_format` viria vazio).

**Baixa / fora de escopo (anotado, não tocado):**

9. `meu_modulo_fiscal/tests/__init__.py` não importa `test_sangria_saldo` nem
   `test_stock_picking_print`, que existem no diretório — ou seja, esses testes
   **não são coletados**. Não mexi (fora do escopo desta feature), mas a
   cobertura dessas duas features parece estar inativa.
10. `meu_modulo_fiscal/tests/` tem testes JS (`test_*.js`) sem runner aparente
    no manifest (`web.qunit_suite_tests` não os lista).

## 7. Segurança

Sem superfície nova relevante: nenhum endpoint HTTP, nenhum `eval`/`exec`, sem
segredos. ACL nova (`x.label.line`, `base.group_user`, CRUD) é necessária porque
todo modelo transiente também exige entrada em `ir.model.access`; o acesso à
lista de produtos e ao wizard continua regido pelos grupos do módulo `stock`
(o menu herda `group_stock_manager`/`group_stock_user` de `stock.menu_stock_root`).

## 8. Commits

| SHA | Mensagem |
|---|---|
| `8601de1` | `feat(estoque): impressão de etiquetas de produto pelo Inventário` (tickets 01–04) |
| `316d41f` | `test(estoque): testes do wizard de etiquetas, smoke de PDF e xml_id` (ticket 05) |

Não houve push nem PR, conforme a instrução. Os testes foram commitados com
`git add -f` porque `tests/` e `.agents/` são gitignored.
