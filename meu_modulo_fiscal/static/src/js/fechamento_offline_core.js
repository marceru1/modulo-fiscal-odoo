/** @odoo-module */
// Cálculo local do fechamento offline (spec fechamento-offline-fila, ticket 02).
// Módulo JS PURO: sem Owl, sem import de @odoo, sem acesso a rede. Recebe o
// snapshot do servidor (ticket 01) + o delta local (pedidos pagos e
// sangrias/suprimentos posteriores) e devolve os dados do popup
// (`get_closing_control_data`) e os do relatório (`get_fechamento_data`).
//
// A aritmética replica os helpers do servidor (comentário aponta a linha):
//   - models/pos_order.py:_calc_saldo_detalhado
//   - models/pos_order.py:_calc_saldo_caixa_dinheiro
//   - models/pos_order.py:_calc_dinheiro_liquido
//   - models/pos_order.py:get_fechamento_data (montagem do payload)
// A paridade JS ↔ Python é garantida pelas fixtures de
// tests/fixtures/fechamento_offline_parity.json.

function numero(valor) {
    return typeof valor === "number" && isFinite(valor) ? valor : 0;
}

function clonar(valor) {
    if (Array.isArray(valor)) {
        return valor.map(clonar);
    }
    if (valor && typeof valor === "object") {
        const copia = {};
        for (const chave of Object.keys(valor)) {
            copia[chave] = clonar(valor[chave]);
        }
        return copia;
    }
    return valor;
}

// Espelha _calc_saldo_detalhado (models/pos_order.py): vendas + recebimentos
// por nome; no método dinheiro o calculado desconta as sangrias.
function calcularSaldoDetalhado(metodos, recebimentosPorMetodo, nomeDinheiro, totalSangrias) {
    const vendasPorMetodo = {};
    for (const metodo of metodos) {
        vendasPorMetodo[metodo.nome] =
            (vendasPorMetodo[metodo.nome] || 0) + numero(metodo.valor);
    }
    const nomes = Object.keys(vendasPorMetodo);
    for (const nome of Object.keys(recebimentosPorMetodo)) {
        if (!nomes.includes(nome)) {
            nomes.push(nome);
        }
    }
    return nomes.map((nome) => {
        let calculado =
            (vendasPorMetodo[nome] || 0) + (recebimentosPorMetodo[nome] || 0);
        if (nome === nomeDinheiro && totalSangrias) {
            calculado -= totalSangrias;
        }
        return {
            nome,
            calculado,
            informado: 0.0,
            diferenca: 0.0 - calculado,
        };
    });
}

/**
 * Calcula o fechamento (popup + relatório) a partir do snapshot e do delta.
 *
 * @param {object} entrada
 * @param {object} entrada.snapshot  saída de get_fechamento_offline_snapshot
 * @param {Array}  [entrada.pedidos] pedidos pagos locais ainda não contados
 *   ({id, amount_total, cliente, data, payments:[{method_id, method_name, type, amount}]})
 * @param {Array}  [entrada.movimentos] sangrias/suprimentos locais
 *   ({tipo: 'in'|'out', valor, motivo, quando})
 * @param {string} [entrada.agora] horário local da confirmação (data_fechamento)
 * @returns {{closing: object, fechamento: object}}
 */
export function calcularFechamentoOffline({
    snapshot,
    pedidos = [],
    movimentos = [],
    agora = "",
}) {
    const closing = clonar((snapshot && snapshot.closing) || {});
    const fechamento = clonar((snapshot && snapshot.fechamento) || {});

    // Delta = pedidos cujo id NÃO está no snapshot. String() dos dois lados:
    // pedido pendente do boot tem id string (uuid) e nunca casa com id numérico.
    const idsContados = new Set(((snapshot && snapshot.order_ids) || []).map(String));
    const deltaPedidos = (pedidos || []).filter(
        (pedido) => !idsContados.has(String(pedido.id))
    );

    const cash = closing.default_cash_details;
    const temCash = Boolean(cash && Object.keys(cash).length);
    const cashId = temCash ? cash.id : null;

    // ── Agrupa pagamentos do delta ────────────────────────────────────────
    let cashDelta = 0;
    let deltaTotal = 0;
    const naoCash = new Map();
    const vendasPrazoDelta = [];

    for (const pedido of deltaPedidos) {
        deltaTotal += numero(pedido.amount_total);
        for (const pagamento of pedido.payments || []) {
            const valor = numero(pagamento.amount);
            const ehDinheiro =
                temCash &&
                pagamento.method_id != null &&
                String(pagamento.method_id) === String(cashId);

            if (ehDinheiro) {
                cashDelta += valor;
            } else {
                const chave =
                    pagamento.method_id != null
                        ? String(pagamento.method_id)
                        : `nome:${pagamento.method_name}`;
                if (!naoCash.has(chave)) {
                    naoCash.set(chave, {
                        id: pagamento.method_id != null ? pagamento.method_id : null,
                        name: pagamento.method_name || "",
                        amount: 0,
                        number: 0,
                        type: pagamento.type || "",
                    });
                }
                const grupo = naoCash.get(chave);
                grupo.amount += valor;
                grupo.number += 1;
                if (!grupo.type) {
                    grupo.type = pagamento.type || "";
                }
                if (!grupo.name && pagamento.method_name) {
                    grupo.name = pagamento.method_name;
                }
            }

            if (pagamento.type === "pay_later") {
                vendasPrazoDelta.push({
                    cliente: pedido.cliente || "CONSUMIDOR",
                    data: pedido.data || "",
                    valor,
                });
            }
        }
    }

    // Movimentos locais no shape dos `moves` do popup (out negativo, in positivo).
    const movimentosDelta = (movimentos || []).map((movimento) => ({
        name: movimento.motivo || "",
        amount: movimento.tipo === "out" ? -numero(movimento.valor) : numero(movimento.valor),
    }));

    // ── Popup (get_closing_control_data) ──────────────────────────────────
    closing.orders_details = closing.orders_details || { quantity: 0, amount: 0 };
    closing.orders_details.quantity = numero(closing.orders_details.quantity) + deltaPedidos.length;
    closing.orders_details.amount = numero(closing.orders_details.amount) + deltaTotal;

    if (temCash) {
        cash.payment_amount = numero(cash.payment_amount) + cashDelta;
        cash.moves = (cash.moves || []).concat(movimentosDelta);
        const totalMoves = cash.moves.reduce((soma, move) => soma + numero(move.amount), 0);
        // amount = opening + vendas em dinheiro + moves (core pos_session.py).
        cash.amount = numero(cash.opening) + numero(cash.payment_amount) + totalMoves;
    }

    closing.non_cash_payment_methods = closing.non_cash_payment_methods || [];
    for (const grupo of naoCash.values()) {
        const existente = closing.non_cash_payment_methods.find(
            (pm) =>
                (grupo.id != null && pm.id != null && String(pm.id) === String(grupo.id)) ||
                (grupo.id == null && pm.name === grupo.name)
        );
        if (existente) {
            existente.amount = numero(existente.amount) + grupo.amount;
            existente.number = numero(existente.number) + grupo.number;
        } else {
            closing.non_cash_payment_methods.push({
                name: grupo.name,
                amount: grupo.amount,
                number: grupo.number,
                id: grupo.id,
                type: grupo.type,
            });
        }
    }

    // ── Relatório (get_fechamento_data) ───────────────────────────────────
    fechamento.identificacao = fechamento.identificacao || {};
    fechamento.identificacao.qtd_vendas =
        numero(fechamento.identificacao.qtd_vendas) + deltaPedidos.length;
    fechamento.identificacao.qtd_cupons =
        numero(fechamento.identificacao.qtd_cupons) + deltaPedidos.length;
    if (agora) {
        fechamento.identificacao.data_fechamento = agora;
    }

    const metodos = fechamento.metodos_pagamento || [];
    const acharMetodo = (nome) => {
        let metodo = metodos.find((item) => item.nome === nome);
        if (!metodo) {
            metodo = { nome, valor: 0 };
            metodos.push(metodo);
        }
        return metodo;
    };

    if (temCash && cash.name) {
        const metodoCash = acharMetodo(cash.name);
        metodoCash.valor = numero(metodoCash.valor) + cashDelta;
    }
    for (const grupo of naoCash.values()) {
        const metodo = acharMetodo(grupo.name);
        metodo.valor = numero(metodo.valor) + grupo.amount;
    }
    fechamento.metodos_pagamento = metodos;
    fechamento.total_vendas = metodos.reduce((soma, item) => soma + numero(item.valor), 0);

    fechamento.vendas_prazo = (fechamento.vendas_prazo || []).concat(vendasPrazoDelta);
    fechamento.total_vendas_prazo = fechamento.vendas_prazo.reduce(
        (soma, item) => soma + numero(item.valor),
        0
    );

    const sangriasDelta = [];
    const suprimentosDelta = [];
    for (const movimento of movimentos || []) {
        const item = { motivo: movimento.motivo || "", valor: Math.abs(numero(movimento.valor)) };
        if (movimento.tipo === "out") {
            sangriasDelta.push(item);
        } else {
            suprimentosDelta.push(item);
        }
    }
    fechamento.sangrias = (fechamento.sangrias || []).concat(sangriasDelta);
    fechamento.suprimentos = (fechamento.suprimentos || []).concat(suprimentosDelta);
    fechamento.total_sangrias = fechamento.sangrias.reduce(
        (soma, item) => soma + numero(item.valor),
        0
    );
    fechamento.total_suprimentos = fechamento.suprimentos.reduce(
        (soma, item) => soma + numero(item.valor),
        0
    );

    fechamento.recebimentos = fechamento.recebimentos || [];
    fechamento.total_recebimentos = fechamento.recebimentos.reduce(
        (soma, item) => soma + numero(item.valor),
        0
    );
    const recebimentosPorMetodo = {};
    for (const recebimento of fechamento.recebimentos) {
        const nome = recebimento.forma_pagamento || "—";
        recebimentosPorMetodo[nome] =
            (recebimentosPorMetodo[nome] || 0) + numero(recebimento.valor);
    }

    const fundoCaixa = numero(fechamento.identificacao.fundo_caixa);
    const nomeDinheiro = (temCash && cash.name) || "Dinheiro";
    const cashPaymentAmount = temCash ? numero(cash.payment_amount) : 0;

    // _calc_dinheiro_liquido
    fechamento.dinheiro_liquido = cashPaymentAmount - fechamento.total_sangrias;

    // _calc_saldo_caixa_dinheiro (gaveta física: só dinheiro)
    const entradasGaveta =
        fundoCaixa +
        cashPaymentAmount +
        fechamento.total_suprimentos +
        (recebimentosPorMetodo[nomeDinheiro] || 0);
    const saidasGaveta = fechamento.total_sangrias;
    fechamento.saldo_movimentacao = {
        entradas: entradasGaveta,
        saidas: saidasGaveta,
        saldo: entradasGaveta - saidasGaveta,
    };

    // Movimentação total (todos os métodos — auditoria), como no servidor.
    const entradasTotal =
        fechamento.total_vendas +
        fundoCaixa +
        fechamento.total_suprimentos +
        fechamento.total_recebimentos;
    fechamento.movimentacao_total = {
        entradas: entradasTotal,
        saidas: fechamento.total_sangrias,
        saldo: entradasTotal - fechamento.total_sangrias,
    };

    fechamento.saldo_detalhado = calcularSaldoDetalhado(
        metodos,
        recebimentosPorMetodo,
        nomeDinheiro,
        fechamento.total_sangrias
    );

    return { closing, fechamento };
}
