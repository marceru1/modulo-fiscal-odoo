# Botão Atualizar PDV

## Problem Statement

Operadores de caixa ficam presos em telas travadas ou com comportamento estranho no PDV e dependem do gestor ou de um teclado físico para pressionar F5. Isso causa fila e interrupção de operação.

## Solution

Adicionar um item "Atualizar" no menu sanduíche do POS, posicionado logo abaixo do item "Recebimento", que executa `window.location.reload()`. O botão fica **oculto** (não apenas desabilitado) quando o POS está offline ou possui dados de contingência não sincronizados, evitando perda de pedido pendente.

## User Stories

1. As an operador de caixa, I want a button "Atualizar" in the hamburger menu, so that I can self-recover a frozen or glitchy screen without calling the manager or using a keyboard.
2. As an operador de caixa, I want the button to disappear when the POS is offline or has unsynced orders, so that I cannot accidentally lose contingency orders by reloading.

## Implementation Decisions

- **Posição no menu:** xpath `position="after"` no `DropdownItem` do item "Recebimento" (mesmo padrão de `recebimento_button.xml`)
- **Mecanismo de reload:** `window.location.reload()` — simples, sem dependência de serviço
- **Visibilidade:** `t-if="canRefreshPOS"` no template; getter `get canRefreshPOS()` no patch do Navbar retorna `true` somente quando `this.pos.data.network.offline === false` **e** `this.pos.data.network.unsyncData.length === 0`
- **Estratégia offline (DEC-002 — decisão do dono):** botão **oculto** (não desabilitado) quando offline. Ocultar é mais seguro: remove completamente a possibilidade de acidente; não há necessidade de tooltip explicativo.
- **Reuso de patch:** criar arquivo JS separado `atualizar_button.js` — NÃO mexer em `pos_menu_cleanup.js` nem em `recebimento_button.js`. Chesterton Fence: cada patch tem sua responsabilidade única.
- **Template XML:** novo arquivo `atualizar_button.xml` herdando `point_of_sale.Navbar` em modo extension.
- **Sem confirmação:** o gesto (abrir menu → clicar) já é suficiente como confirmação implícita quando online. Adicionar um dialog seria over-engineering para o caso de uso (tela travada = o operador quer sair logo).
- **Sem backend:** zero campos, zero modelos, zero migração. Feature 100% frontend.

## Testing Decisions

**O que faz um bom teste:**
- Verificar que o getter `canRefreshPOS` retorna `false` quando `network.offline === true`
- Verificar que o getter `canRefreshPOS` retorna `false` quando `unsyncData.length > 0`
- Verificar que o getter `canRefreshPOS` retorna `true` quando online e sem dados pendentes
- Verificar que o botão aparece no DOM quando `canRefreshPOS` é true e desaparece quando false

**Seam de teste:** getter `canRefreshPOS` no Navbar — seam de mais alto nível possível (lógica de apresentação sem necessidade de mockar DOM).

**Teste manual no POS:**
1. **Online, sem pedido pendente:** abrir menu sanduíche → ver "Atualizar" → clicar → POS recarrega. ✅
2. **Simulando offline (DevTools → Network → Offline):** abrir menu sanduíche → "Atualizar" NÃO aparece. ✅
3. **Pedido em contingência não sincronizado (`unsyncData.length > 0`):** abrir menu sanduíche → "Atualizar" NÃO aparece. ✅
4. **Após voltar online e sincronizar:** abrir menu sanduíche → "Atualizar" reaparece. ✅

**Regressão:** verificar que "Recebimento" continua aparecendo acima do "Atualizar".

## Out of Scope

- Confirmação de reload via dialog
- Botão de reload fora do menu sanduíche (ex: navbar fixa, tela de pagamento)
- Limpar cache do service worker antes de recarregar
- Lógica de retry de sincronização antes do reload
- Qualquer alteração no backend (modelos, views, controllers)

## Further Notes

- `this.pos.data.network` é o objeto reativo do Odoo 18 definido em `data_service.js`. O campo `offline` é setado pelo listener `browser.addEventListener("offline", ...)` e o campo `unsyncData` é um array de objetos com `uuid` de pedidos não sincronizados.
- O padrão de ocultar com `t-if` (em vez de `t-att-disabled`) é consistente com o padrão adotado no projeto (ver `recebimento_button.xml`: `t-if="showCashMoveButton"`).
- **Sem necessidade de `useService("network")` ou qualquer import adicional** — `this.pos.data` já está disponível no Navbar via `this.pos` (injetado pelo POS store).

## ADRs

- **DEC-001: Posição no menu**
  - Context: O pedido do usuário especifica "embaixo do item Recebimentos".
  - Decision: xpath `position="after"` no DropdownItem do showRecebimento, espelhando o padrão de `recebimento_button.xml` que usa `position="after"` no cashMove.
  - Consequences: Ordem garantida: Movimentações de caixa → Recebimento → **Atualizar** → demais itens.

- **DEC-002: Ocultar vs. desabilitar quando offline (decisão do dono — não re-grill)**
  - Context: Se o botão ficar visível mas desabilitado, um operador sem contexto pode confundir com bug da tela; se ficar oculto, nunca há risco de clique acidental.
  - Decision: `t-if="canRefreshPOS"` — botão oculto quando `network.offline || unsyncData.length > 0`.
  - Consequences: Zero possibilidade de perda de pedido de contingência via reload. Trade-off: operador não recebe feedback visual de "por que sumiu o botão" — aceitável porque quando offline o POS já exibe o badge de aviso.

- **DEC-003: `window.location.reload()` direto, sem serviço**
  - Context: Alternativas seriam usar router do Odoo ou `window.location.href = window.location.href`. `reload()` é o mais simples e idiomático para "F5".
  - Decision: `window.location.reload()` direto no handler inline do template XML.
  - Consequences: Mais simples possível. Sem side-effects de router. Recarrega tudo do zero (cache incluso), que é exatamente o comportamento desejado para resolver tela travada.

- **DEC-004: Arquivo JS/XML separado, sem mexer nos patches existentes**
  - Context: `pos_menu_cleanup.js` e `recebimento_button.js` já têm seus patches estáveis em produção. Fundir aumentaria o risco de regressão.
  - Decision: Criar `atualizar_button.js` e `atualizar_button.xml` novos.
  - Consequences: Um patch extra no `Navbar.prototype` — Odoo 18 suporta múltiplos patches no mesmo prototype sem conflito desde que não sobrescrevam os mesmos métodos/getters.

- **DEC-005: Dependência de template entre `recebimento_button.xml` e `atualizar_button.xml`**
  - Context: A posição "logo abaixo de Recebimento" exige que o node âncora (`//DropdownItem[@onSelected='() => this.showRecebimento()']`) exista no template `point_of_sale.Navbar` quando o xpath de `atualizar_button.xml` for aplicado. Esse node não existe no template nativo do Odoo; ele é criado por `recebimento_button.xml`.
  - Decision: Aceitar o acoplamento implícito e declarar `atualizar_button.xml` **depois** de `recebimento_button.xml` no bundle `point_of_sale._assets_pos`. Isso espelha o padrão pré-existente `acrescimo_button.xml` → `desconto_button.xml` (o desconto ancora num node criado pelo acréscimo).
  - Consequences: Garante a ordem visual exata pedida pelo usuário (Movimentações de caixa → Recebimento → Atualizar). Trade-off: se `recebimento_button.xml` for renomeado, removido ou reordenado, o render do POS quebra. Mitigação: comentários no `__manifest__.py` e no XML, mais teste standalone `.agents/tests/test_manifest_order.py` que falha se a ordem for violada.
