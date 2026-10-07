# Code Review: etiquetas-produto-impressao (impressão direta QZ Tray)

**Data:** 2026-10-06 16:19
**Fixed point:** branch `dev` @ `3a5739a` (diff `8601de1`~1 → HEAD, 14 commits de etiqueta)
**Veredicto:** REQUEST CHANGES — 1 Critical

---

## Resumo

O eixo "impressão direta pelo QZ Tray" está **bom**: payload servidor→JS correto, `urgentSave` antes do render (bug do "sempre sai 1 etiqueta" coberto por ordem testada), decisão de impressora pelo formato, rotação via injeção da matriz `cm` (o `/Rotate` é ignorado pelo rasterizador — descoberta real documentada). A suíte de contrato estática passou verde aqui (48 asserções).

Porém o commit `3a5739a` introduziu uma regressão no CSS: a view `etiqueta_styles_bijuteria` é uma **extension** (`inherit_id="etiqueta_styles"`) com `position="replace"` no `<style>` inteiro. No Odoo 18, `_get_combined_arch()` (ir_ui_view.py:936) aplica a extension a **todo render da mãe**, então a **Confecção hoje herda o CSS da Bijuteria** (34,8mm), apagando as regras de 105mm. Foi **provado por render real** no banco `grupo20mais`: página física 105×60mm correta, mas conteúdo amassado no terço esquerdo (3 etiquetas em ~36mm) e colado no topo (o `padding-top: 21,5mm` da faixa pré-impressa também se perdeu).

⚠️ **O "100% funcional" é válido apenas para a Bijuteria.** A Confecção imprime do jeito que está (a página do QZ Tray continua 105mm — o driver não sabe o que é CSS), mas: 2 cópias sairia empilhado na coluna esquerda em vez de lado a lado, o conteúdo imprimiria sobre a faixa de logo pré-impressa, e em etiqueta 35mm fisicamente a impressão sairia a ~1/3 da largura da bobina de 105mm.

---

## Critical

- **[report/etiqueta_styles.xml:104] `etiqueta_styles_bijuteria` como extension + `position="replace"` corrompe a Confecção.** `_read_template` → `_get_combined_arch()` combina mãe+filha no **banco**; confirmado em consulta real: arch combinado de `etiqueta_styles` contém `34.8mm`, NÃO contém `105mm` nem `.x_etiqueta_confeccao`. Correção recomendada (seguindo a regra do próprio AGENTS.md sobre `position="replace"`): a Bijuteria chama um template de estilo **independente e completo** (`etiqueta_styles_bijuteria`, standalone, sem `inherit_id`) — nada herda da mãe. A Confecção fica exatamente como está hoje (chama `etiqueta_styles` intacta, com o bloco Confecção de volta).

## Important

- **[views/etiquetas_wizard_views.xml:20] `x_rotate_degrees` no form é redundante e expõe decisão técnica ao operador.** `_x_rotate_degrees()` (product_label_layout.py:204) já documenta a resolução wizard→default da classe, e `_X_LABEL_ROTATE_DEFAULT = '0'` cobre DEV. Se o valor 180 precisa vir por banco (PROD), faixa pré-impressa e orientação de driver são config de máquina — campo per-expressão é um ajuste fino escondido no lugar errado (o default por banco já existe como mecanismo: `default_get`). Sugestão: manter o campo no modelo, tirar da view, ou condicionar `groups="base.group_system"`.
- **[product_label_layout.py:6–9] `_x_rotate_etiqueta_pdf` e `_x_qz_config` são código morto.** O payload consome apenas `base64` + `_X_LABEL_PAGE_MM`; `_x_qz_config` (linha 214) tem zero chamadas (só pycache), `NumberObject` está importado sem uso, e a docstring do payload ainda promete `'rotation'` que não vai no dict. Matar os dois + consertar a docstring evita o próximo "regra de ouro" fantasma.

## Sugestões

- Testes de contrato quebrariam de verdade nestes 3 pontos (hoje são asserções de string/ordem; qualquer mudança de nome/caminho exige re-verificação manual). Os testes de py_compile/ACL/lxml do primeiro ciclo valem como smoke barato.
- O teste que busca a fila por índice no código (`js.rindex("/l42/i") < js.rindex("/elgin/i")`) é frágil a reordenamento de comentários; o teste de ordem `urgentSave` logo abaixo já faz a coisa certa (compara ordem no código sem comentários).
- O `t-if="idx < len(fila)"` + `t-else` slot vazio nos templates está correto, e a fila achatada `[(produto, barcode) * qtd]` dá a ordem "produto completo em sequência" — bom para etiquetar o lote de um produto de uma vez.

## Feito bem

- `_x_rotate_etiqueta_pdf` — engenharia de verdade: quatro caminhos abandonados documentados com o porquê testado, escolha da matriz `cm` correta.
- Contratos via `.agents/tests/test_etiqueta_qz_print.py` executam rápido, sem Odoo, com comentários que ensinam (bug do `setPromise`, `urgentSave`, asset de cliente ≠ forma de servidor).
- `_x_qz_print` como campo-botão é um hack limpo e legível dentro da form do core.

## Verificações realizadas (todas leitura/render, nada alterado)

- Suíte de contrato: `test_etiqueta_qz_print.py` 48/48 OK; `test_etiquetas_xmlids.py` OK.
- Consulta ao banco real (`grupo20mais`): views em `-u` real — extension presente, arch combinado sem 105mm.
- Render real via `_render_qweb_pdf` no `grupo20mais`: **Confecção:** 4 págs, 105,1×60,0mm, conteúdo comprimido <36mm, topo colado. **Bijuteria:** 12 págs, 34,9×20,1mm, íntegra.
- PNG 600dpi de página 1 da Confecção: conteúdo confinado ao terço esquerdo, sem respeitar a faixa de logo.

---

## Resolução (2026-10-07)

- **Critical corrigido** em `6b8ce90`: `etiqueta_styles_bijuteria` convertida de extension para view prima standalone via `<record>` (`mode="primary"`, `inherit_id=False`) — atualiza o mesmíssimo registro do banco em vez de deixar extension órfã arquivada (o `-u` não remove `inherit_id` de registro que o XML parou de declarar: `_tag_template` em convert.py:453 só transcreve o que o XML traz).
- **Guard anti-regressão** na suíte `test_etiquetas_xmlids.py`: template com `inherit_id` de estilo de etiqueta e registro sem `primary`/`inherit_id=False` falham o teste.
- **Re-verificação real no banco (`-u grupo20mais` + render):** Confecção `105,1×60,0mm`, conteúdo até `x=102,8mm`, começa em `y=21,2mm` (faixa de logo preservada); Bijuteria `34,9×20,1mm` íntegra. PNGs conferidos visualmente: 3 colunas lado a lado, nome/barcode/dígitos/preço/rodapé em todas.
- Veredicto passa a **APPROVE** (o Important de código morto `_x_qz_config`/`NumberObject` e o `x_rotate_degrees` na view ficam em aberto, fora do escopo deste fix).