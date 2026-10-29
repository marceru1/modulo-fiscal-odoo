/**
 * Teste unitário (Node puro, sem Odoo) do cálculo local do fechamento
 * offline (fechamento_offline_core.js — ticket 02).
 *
 * Consome as fixtures de paridade compartilhadas com o teste Python
 * (fixtures/fechamento_offline_parity.json) e cobre os casos extras:
 * pedido já no snapshot (sem duplicar), pedido pendente do boot (id string),
 * sem controle de caixa / sem método de dinheiro, e imutabilidade do snapshot.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_fechamento_offline_core.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const SOURCE = path.join(__dirname, "..", "static", "src", "js", "fechamento_offline_core.js");
const FIXTURES = path.join(__dirname, "fixtures", "fechamento_offline_parity.json");

function loadModule(file, exportNames) {
    let src = fs.readFileSync(file, "utf8");
    src = src.replace(/^\/\*\* @odoo-module \*\/\s*/m, "");
    src = src.replace(/\bexport\s+(const|function|class)\s+/g, "$1 ");
    return vm.runInNewContext(`(() => { ${src}\n return { ${exportNames.join(", ")} }; })()`, {
        console,
    });
}

const { calcularFechamentoOffline } = loadModule(SOURCE, ["calcularFechamentoOffline"]);
const fixtures = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));

// ── Normalizador de paridade (espelha tests/paridade_offline_helper.py) ───
function r(valor) {
    const n = typeof valor === "number" && isFinite(valor) ? valor : 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function porNome(a, b) {
    return String(a.nome || "").localeCompare(String(b.nome || ""));
}

function paridade(closing = {}, fechamento = {}) {
    const cash = closing.default_cash_details || {};
    const orders = closing.orders_details || {};
    const ident = fechamento.identificacao || {};

    return {
        closing: {
            orders_details: {
                quantity: Number(orders.quantity || 0),
                amount: r(orders.amount || 0),
            },
            cash: Object.keys(cash).length
                ? {
                      name: cash.name || null,
                      amount: r(cash.amount || 0),
                      opening: r(cash.opening || 0),
                      payment_amount: r(cash.payment_amount || 0),
                      moves_total: r(
                          (cash.moves || []).reduce((s, m) => s + (m.amount || 0), 0)
                      ),
                  }
                : {},
            non_cash: (closing.non_cash_payment_methods || [])
                .map((pm) => ({
                    name: pm.name || null,
                    amount: r(pm.amount || 0),
                    number: Number(pm.number || 0),
                    type: pm.type || null,
                }))
                .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
        },
        fechamento: {
            qtd_vendas: Number(ident.qtd_vendas || 0),
            qtd_cupons: Number(ident.qtd_cupons || 0),
            metodos_pagamento: (fechamento.metodos_pagamento || [])
                .map((m) => ({ nome: m.nome || null, valor: r(m.valor || 0) }))
                .sort(porNome),
            total_vendas: r(fechamento.total_vendas || 0),
            vendas_prazo: (fechamento.vendas_prazo || [])
                .map((v) => ({ cliente: v.cliente || null, valor: r(v.valor || 0) }))
                .sort((a, b) =>
                    `${a.cliente}|${a.valor}`.localeCompare(`${b.cliente}|${b.valor}`)
                ),
            total_vendas_prazo: r(fechamento.total_vendas_prazo || 0),
            sangrias: (fechamento.sangrias || [])
                .map((s) => ({ motivo: s.motivo || null, valor: r(s.valor || 0) }))
                .sort((a, b) =>
                    `${a.motivo}|${a.valor}`.localeCompare(`${b.motivo}|${b.valor}`)
                ),
            total_sangrias: r(fechamento.total_sangrias || 0),
            suprimentos: (fechamento.suprimentos || [])
                .map((s) => ({ motivo: s.motivo || null, valor: r(s.valor || 0) }))
                .sort((a, b) =>
                    `${a.motivo}|${a.valor}`.localeCompare(`${b.motivo}|${b.valor}`)
                ),
            total_suprimentos: r(fechamento.total_suprimentos || 0),
            total_recebimentos: r(fechamento.total_recebimentos || 0),
            dinheiro_liquido: r(fechamento.dinheiro_liquido || 0),
            saldo_movimentacao: {
                entradas: r((fechamento.saldo_movimentacao || {}).entradas || 0),
                saidas: r((fechamento.saldo_movimentacao || {}).saidas || 0),
                saldo: r((fechamento.saldo_movimentacao || {}).saldo || 0),
            },
            movimentacao_total: {
                entradas: r((fechamento.movimentacao_total || {}).entradas || 0),
                saidas: r((fechamento.movimentacao_total || {}).saidas || 0),
                saldo: r((fechamento.movimentacao_total || {}).saldo || 0),
            },
            saldo_detalhado: (fechamento.saldo_detalhado || [])
                .map((s) => ({ nome: s.nome || null, calculado: r(s.calculado || 0) }))
                .sort(porNome),
        },
    };
}

// ── Fixtures de paridade ───────────────────────────────────────────────────
for (const cenario of fixtures.cenarios) {
    const resultado = calcularFechamentoOffline({
        snapshot: cenario.snapshot,
        pedidos: cenario.eventos.pedidos,
        movimentos: cenario.eventos.movimentos,
        agora: cenario.eventos.agora,
    });
    // JSON: o resultado vem do realm do vm (protótipos diferentes).
    assert.strictEqual(
        JSON.stringify(paridade(resultado.closing, resultado.fechamento)),
        JSON.stringify(paridade(cenario.esperado.closing, cenario.esperado.fechamento)),
        `Fixture ${cenario.nome} divergiu`
    );
    console.log(`✓ Fixture: ${cenario.nome}`);
}

// ── Caso extra: pedido já contado no snapshot não duplica ─────────────────
{
    const cenario = fixtures.cenarios.find((c) => c.nome === "venda_dinheiro");
    const snapshot = JSON.parse(JSON.stringify(cenario.snapshot));
    snapshot.order_ids = [201]; // o pedido do delta já está contado
    const resultado = calcularFechamentoOffline({
        snapshot,
        pedidos: cenario.eventos.pedidos,
        movimentos: [],
        agora: "27/10/2026 18:00:00",
    });
    assert.strictEqual(resultado.closing.orders_details.quantity, 0);
    assert.strictEqual(resultado.closing.orders_details.amount, 0);
    assert.strictEqual(resultado.closing.default_cash_details.payment_amount, 0);
    assert.strictEqual(resultado.fechamento.total_vendas, 0);
    console.log("✓ Caso extra: pedido já no snapshot não duplica");
}

// ── Caso extra: pedido pendente do boot (id string) é contado ─────────────
{
    const cenario = fixtures.cenarios.find((c) => c.nome === "venda_dinheiro");
    const resultado = calcularFechamentoOffline({
        snapshot: cenario.snapshot,
        pedidos: cenario.eventos.pedidos.map((p) => ({ ...p, id: "uuid-pendente-1" })),
        movimentos: [],
        agora: "",
    });
    assert.strictEqual(resultado.closing.orders_details.quantity, 1);
    assert.strictEqual(resultado.closing.default_cash_details.payment_amount, 60);
    console.log("✓ Caso extra: pedido pendente do boot (id string) é contado");
}

// ── Caso extra: sem controle de caixa / sem método de dinheiro ────────────
{
    const snapshot = {
        closing: {
            orders_details: { quantity: 0, amount: 0 },
            default_cash_details: {}, // sem método de dinheiro
            non_cash_payment_methods: [
                { name: "Cartão", amount: 0, number: 0, id: 2, type: "bank" },
            ],
        },
        fechamento: {
            identificacao: { fundo_caixa: 0, qtd_vendas: 0, qtd_cupons: 0 },
            metodos_pagamento: [{ nome: "Cartão", valor: 0 }],
            total_vendas: 0,
            vendas_prazo: [],
            sangrias: [],
            suprimentos: [],
            recebimentos: [],
            saldo_detalhado: [],
        },
        order_ids: [],
    };
    const resultado = calcularFechamentoOffline({
        snapshot,
        pedidos: [
            {
                id: 301,
                amount_total: 30,
                payments: [
                    { method_id: 2, method_name: "Cartão", type: "bank", amount: 30 },
                ],
            },
        ],
        movimentos: [],
    });
    assert.strictEqual(Object.keys(resultado.closing.default_cash_details).length, 0);
    assert.strictEqual(resultado.closing.orders_details.quantity, 1);
    const cartao = resultado.closing.non_cash_payment_methods.find(
        (pm) => pm.name === "Cartão"
    );
    assert.strictEqual(cartao.amount, 30);
    assert.strictEqual(cartao.number, 1);
    assert.strictEqual(resultado.fechamento.total_vendas, 30);
    assert.strictEqual(resultado.fechamento.dinheiro_liquido, 0);
    assert.strictEqual(resultado.fechamento.saldo_movimentacao.saldo, 0);
    console.log("✓ Caso extra: sem controle de caixa conta tudo como não-dinheiro");
}

// ── Caso extra: não muta o snapshot de entrada ────────────────────────────
{
    const cenario = fixtures.cenarios.find((c) => c.nome === "sangria_suprimento");
    const antes = JSON.stringify(cenario.snapshot);
    calcularFechamentoOffline({
        snapshot: cenario.snapshot,
        pedidos: [],
        movimentos: cenario.eventos.movimentos,
        agora: "",
    });
    assert.strictEqual(JSON.stringify(cenario.snapshot), antes, "Snapshot não pode ser mutado");
    console.log("✓ Caso extra: snapshot de entrada não é mutado");
}

console.log("\nTodos os testes passaram ✓");
