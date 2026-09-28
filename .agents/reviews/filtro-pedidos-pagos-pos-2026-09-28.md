# Code Review: filtro-pedidos-pagos-pos

## Review Summary

**Verdict:** REQUEST CHANGES

**Overview:** Implementação 100% frontend, bem focada e alinhada com as decisões arquiteturais (DEC-001 a DEC-007). O patch de `TicketScreen` é mínimo, o XML evita `position="replace"`, e os testes standalone cobrem os seams da spec. Dois pontos precisam ser resolvidos antes do merge: uma inconsistência interna da spec (User Story 3 pede AND entre chips, mas DEC-005/código usam OR) e o filtro por hora, que é suscetível a fuso horário por limitação do core do Odoo.

---

## Critical Issues

Nenhum.

---

## Important Issues

### 1. Inconsistência da spec: User Story 3 vs. DEC-005 / implementação

- **Local:** `.agents/specs/filtro-pedidos-pagos-pos.md` — User Story 3 e Implementation Decisions.
- **Descrição:**
  - A User Story 3 diz: *"Clicar em 'Dinheiro' com 'Pix' já ativo → AND: só pedidos que têm ambos os métodos"*.
  - A DEC-005 diz: *"Pedidos mistos: incluídos em ambos os chips relevantes (OR dentro do campo de pagamento, AND entre campos diferentes)"*.
  - A implementação (`getFilteredOrderList`) e o teste D4 usam OR dentro do campo de pagamento.
- **Recomendação:** Corrigir a spec para remover a ambiguidade. A opção mais coerente com a arquitetura e com a UX de "pedido misto aparece nos chips relevantes" é manter OR dentro do campo e atualizar a User Story 3 para: *"Clicar em 'Dinheiro' com 'Pix' já ativo → OR: pedidos que usam Dinheiro **ou** Pix (incluindo a venda mista)"*. Se o usuário de fato quiser AND, a implementação precisa mudar.
- **Por que é importante:** Sem esse alinhamento, o teste manual no PDV pode ser executado com expectativa errada, gerando bug report falso ou, pior, aprovação de comportamento não intencional.

### 2. Filtro por hora pode não funcionar em fuso diferente de UTC

- **Local:** `meu_modulo_fiscal/static/src/js/filtro_pedidos.js:39-42` (patch do `DATE` field); `point_of_sale/static/src/app/screens/ticket_screen/ticket_screen.js` (core).
- **Descrição:**
  - O field `DATE` do core gera domínio `[["date_order", "ilike", "%HH:MM%"]]` quando o parse falha (hora pura).
  - `date_order` é armazenado em UTC no servidor (`pos_order.py`).
  - Uma venda feita às 14:30 no horário de Brasília é gravada como 17:30 UTC; a busca `"14:30"` não casa no servidor.
  - O client-side `fuzzyLookup` funciona sobre o cache local, mas `totalCount` e paginação vêm do domínio do servidor.
- **Recomendação:**
  - Adicionar à spec um alerta explícito de que o filtro por hora depende de teste manual no fuso real do cliente.
  - Se o teste manual falhar, a solução correta é um field custom com `formatSearch` que converta a hora local para UTC antes de enviar ao domínio — isso está fora do escopo atual, mas deve virar um ticket de débito técnico.
- **Por que é importante:** É uma feature declarada na spec; se não funcionar no fuso do cliente, o operador não consegue usar o filtro por hora.

---

## Suggestions

### S3. Testes de assets são frágeis a mudanças de formatação

- **Local:** `meu_modulo_fiscal/tests/test_filtro_pedidos_assets.js:108`, `meu_modulo_fiscal/tests/test_filtro_pedidos.js:60-63`.
- **Descrição:** Os testes fazem parse textual do JS/XML com regex e contador de balanceamento. Se alguém reformatar o arquivo (ex.: quebrar `t-on-click` em múltiplas linhas ou mudar `patch(TicketScreen.prototype, {` para `patch(TicketScreen.prototype, {\n  `), os testes quebram.
- **Recomendação:** Manter como está (é o melhor possível sem Odoo rodando local), mas documentar nos comentários que os testes são *contrato textual*, não semânticos, e que qualquer refatoração de formatação precisa ser acompanhada de ajuste nos testes.
- **Severidade:** baixa — consciente e aceitável para o contexto.

### S4. Strings `_t()` não estão catalogadas para tradução

- **Local:** `meu_modulo_fiscal/static/src/js/filtro_pedidos.js:42,49`.
- **Descrição:** `displayName: _t("Valor")` e `_t("Data / Hora")` são novas strings. Não há `.po`/`.pot` no módulo para `pt_BR`, então na prática a UI mostra os literais em português.
- **Recomendação:** Criar/regenerar o `.pot` do módulo para capturar essas strings. Isso é bom housekeeping, mas não bloqueia merge.

### S5. `getAvailablePaymentMethods()` não é defensivo contra model ausente

- **Local:** `meu_modulo_fiscal/static/src/js/filtro_pedidos.js:57-59`.
- **Descrição:** Assume que `this.pos.models["pos.payment.method"]` existe. No POS isso é garantido, mas o teste mocka explicitamente. Não é um risco real.
- **Recomendação:** Opcionalmente adicionar `return this.pos.models?.["pos.payment.method"]?.getAll() || [];`. Não bloqueia merge.

---

## What's Done Well

- **Mínima superfície de mudança:** A feature é 100% frontend, não toca em backend, schema, webhook ou `_prepare_nfce_payload()`, reduzindo drasticamente o risco de regressão fiscal/offline.
- **Reutilização do core:** Reaproveita o field `DATE` existente e o `fuzzyLookup` do core em vez de reinventar busca por hora/valor.
- **Ancoragem segura do XML:** Usa `position="after"` no `.controls`, evitando `replace` e sem esconder nodes de outros módulos.
- **Guard contra filtro fantasma:** A checagem `this.state.filter !== "SYNCED"` em `getFilteredOrderList` evita que a lista fique filtrada sem indicador visual quando o operador troca de tab. Foi um desvio consciente e bem documentado do ticket 02.
- **Testes standalone:** Apesar de dependerem de parsing textual, cobrem os contratos principais (seams, OR/AND, guard de tab, manifest, XSS-safe `t-esc`).
- **Comentários com fontes:** O JS cita linhas do core (`ticket_screen.js:601`, `ticket_screen.js:688`, etc.), facilita auditoria.

---

## Verification Story

- **Tests reviewed:** Sim. `test_filtro_pedidos.js` (16 asserções) e `test_filtro_pedidos_assets.js` (11 asserções) passam localmente (`node`).
- **Build verified:** Não aplicável — sem Odoo rodando local; testes são Node puro.
- **Security checked:** Sim. Nenhum `eval`/`exec`, nenhum `t-raw`, nenhum input concatenado em domínio, `position="after"` sem `replace`.

---

## Eixos de Review

### A — Correctness

- O código faz o que DEC-005 diz? Sim.
- O código faz o que a User Story 3 diz? Não — há divergência (ver Important Issue 1).
- Edge cases: vazio (`active.size === 0`), tab não-SYNCED, pedido sem `payment_ids`, pedido misto — todos cobertos.
- O filtro por hora tem problema de fuso (ver Important Issue 2).
- `modelField: null` é a abordagem correta para evitar query backend no `AMOUNT`.

### B — Readability

- Nomes descritivos (`activePaymentMethodIds`, `onTogglePaymentChip`, `getAvailablePaymentMethods`).
- Comentários explicam *por que*, não só *o que*.
- Fluxo de `getFilteredOrderList` é direto: super → guard → filter.

### C — Architecture

- Manteve fronteira do módulo: apenas patch em `TicketScreen` e herança de template.
- Não criou novos modelos/campos.
- Reuso do field `DATE` segue DEC-003.
- Desvio de ancoragem (`.controls` ao invés de `<SearchBar>`) está documentado no XML, no relatório do coder e no teste.

### D — Security

- `t-esc` para `method.name` (XSS-safe).
- Sem `position="replace"`.
- Nenhuma chamada controller ou endpoint novo.
- Nenhum segredo hardcoded.

### E — Performance

- Filtro client-side, O(n × m × p) onde n = pedidos na página atual, m = chips ativos, p = pagamentos por pedido. Volume pequeno (página de 30), imperceptível.
- Sem chamadas extras ao backend.
