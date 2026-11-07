/**
 * Teste unitário (Node puro, sem Odoo) do seam de limite a prazo do PDV
 * (spec prazo-por-contato): o limite vive no CONTATO, lido por UMA chamada
 * ORM com sudo (_prazo_limite_credito).
 *
 * O teste:
 *   1. Lê static/src/js/auto_invoice_pay_later.js.
 *   2. Testa a helper pura _checkLimitePrazo (seam de regra: 190 + 11 > 200).
 *   3. Extrai o objeto passado a patch(PaymentScreen.prototype, {...}) e o
 *      executa sobre um mock de PaymentScreen.prototype com super.validateOrder()
 *      e um `this` mockado (pos, dialog, env.services.orm, notification).
 *   4. Verifica os comportamentos decididos:
 *        - excedido      → HARD BLOCK (super NÃO chamado)
 *        - sem_limite    → HARD BLOCK também (DEC-C; botão único "Entendi")
 *        - ok            → super chamado + set_to_invoice(true)
 *        - ORM/offline   → HARD BLOCK com pay_later (super NÃO chamado)
 *
 * Rodar: node meu_modulo_fiscal/tests/test_auto_invoice_pay_later.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const JS_PATH = path.join(MODULE_ROOT, "static", "src", "js", "auto_invoice_pay_later.js");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(JS_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

// ── Extração de blocos balanceados (chaves/parênteses/colchetes) ───────────
function extractBalanced(src, openIdx) {
    const openers = "{([";
    const closers = "})]";
    let depth = 0;
    let quote = null;
    for (let i = openIdx; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (ch === "\\") {
                i++;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            continue;
        }
        if (openers.includes(ch)) {
            depth++;
        } else if (closers.includes(ch)) {
            depth--;
            if (depth === 0) {
                return src.slice(openIdx, i + 1);
            }
        }
    }
    throw new Error("bloco não balanceado");
}

// ── Extração da helper pura _checkLimitePrazo ───────────────────────────────
const helperMarker = "export function _checkLimitePrazo(";
const helperIdx = source.indexOf(helperMarker);
assert(helperIdx !== -1, `não achou "${helperMarker}"`);
const helperBody = extractBalanced(source, source.indexOf("{", helperIdx));
const helperDecl = source.slice(helperIdx, source.indexOf("{", helperIdx)).replace("export function", "function");
const _checkLimitePrazo = new Function(
    `${helperDecl} ${helperBody}; return _checkLimitePrazo;`
)();

// ── Extração do objeto literal passado a patch() ────────────────────────────
const patchMarker = "patch(PaymentScreen.prototype,";
const patchIdx = source.indexOf(patchMarker);
assert(patchIdx !== -1, `não achou "${patchMarker}"`);
const objLiteral = extractBalanced(source, source.indexOf("{", patchIdx));

// ask vem do make_awaitable_dialog; injetamos mock que captura props e resolve.
let lastAskProps = null;
let askResult = true;
function ask(dialog, props) {
    lastAskProps = props;
    return Promise.resolve(askResult);
}

const patchObj = new Function("ask", "_checkLimitePrazo", `return (${objLiteral});`)(
    ask,
    _checkLimitePrazo
);

// ── Mock da base (super.validateOrder) ──────────────────────────────────────
const baseMock = {
    async validateOrder(isForceValidate) {
        this.__superCalled = true;
        this.__superArgs = [isForceValidate];
    },
};
Object.setPrototypeOf(patchObj, baseMock);

// ── Helpers de mock ─────────────────────────────────────────────────────────
function makeOrder({ hasPayLater = true, total = 11, partner = null } = {}) {
    const order = {
        payment_ids: hasPayLater
            ? [{ payment_method_id: { type: "pay_later" } }]
            : [{ payment_method_id: { type: "cash" } }],
        amount_total: total,
        get_total_with_tax: () => total,
        get_partner: () => partner,
        __setToInvoice: false,
        set_to_invoice(v) {
            this.__setToInvoice = v;
        },
    };
    return order;
}

function makeThis({ order, ormThrows = false } = {}) {
    return {
        pos: { get_order: () => order },
        dialog: { add: () => {} },
        env: {
            services: {
                orm: {
                    call: () => {
                        if (ormThrows) {
                            return Promise.reject(new Error("network down"));
                        }
                        return Promise.resolve({ credit: 190, credit_limit: 200 });
                    },
                    searchRead: () => {
                        throw new Error(
                            "searchRead não deve ser chamado: o limite vem do seam único"
                        );
                    },
                },
                notification: { add: () => {} },
            },
        },
    };
}

async function runValidate(ctx) {
    lastAskProps = null;
    ctx.__superCalled = false;
    ctx.__superArgs = undefined;
    const order = ctx.pos.get_order();
    order.__setToInvoice = false;
    await patchObj.validateOrder.call(ctx, false);
}

async function main() {
    // ── Grupo A: helper _checkLimitePrazo (seam da regra de limite) ─────────

    // A1: excedido quando credit + total > limite
    {
        const partner = { name: "Cliente Teste" };
        const result = _checkLimitePrazo(partner, 11, { credit: 190, credit_limit: 200 });
        assert.strictEqual(result.ok, false, "deve detectar excedido");
        assert.strictEqual(result.tipo, "excedido", "tipo deve ser 'excedido'");
        assert(/200\.00/.test(result.msg), "msg deve citar o limite");
        console.log("✓ A1: _checkLimitePrazo detecta excedido (190 + 11 > 200)");
    }

    // A2: sem_limite quando limite <= 0
    {
        const partner = { name: "Cliente Teste" };
        const result = _checkLimitePrazo(partner, 10, { credit: 0, credit_limit: 0 });
        assert.strictEqual(result.ok, false, "deve detectar sem_limite");
        assert.strictEqual(result.tipo, "sem_limite", "tipo deve ser 'sem_limite'");
        assert(/ficha do contato/.test(result.msg), "msg orienta cadastrar no contato");
        console.log("✓ A2: _checkLimitePrazo detecta sem_limite");
    }

    // A3: ok quando credit + total <= limite
    {
        const partner = { name: "Cliente Teste" };
        const result = _checkLimitePrazo(partner, 10, { credit: 190, credit_limit: 200 });
        assert.strictEqual(result.ok, true, "deve permitir ok");
        assert.strictEqual(result.tipo, undefined, "ok não tem tipo");
        console.log("✓ A3: _checkLimitePrazo permite ok quando cabe no limite");
    }

    // A4: limite vem EXCLUSIVAMENTE do credit_limit do contato (sem funcionário)
    {
        const partner = { name: "Cliente Teste" };
        const result = _checkLimitePrazo(partner, 201, { credit: 0, credit_limit: 200 });
        assert.strictEqual(result.tipo, "excedido", "deve usar o credit_limit do contato");
        console.log("✓ A4: _checkLimitePrazo usa o credit_limit do contato");
    }

    // ── Grupo B: validateOrder — excedido → HARD BLOCK ────────────────────────

    // B1: excedido não chama super.validateOrder()
    {
        askResult = true; // clique em "Entendi" não deve fazer a venda avançar
        const order = makeOrder({ hasPayLater: true, total: 11, partner: { id: 1, name: "A" } });
        const ctx = makeThis({ order });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, false, "excedido deve BLOQUEAR super.validateOrder()");
        assert.strictEqual(order.__setToInvoice, false, "excedido não deve marcar to_invoice");
        assert(lastAskProps, "deve abrir modal");
        assert.strictEqual(lastAskProps.title, "⚠️ Limite a Prazo Excedido", "título do modal excedido");
        assert.strictEqual(
            lastAskProps.confirmLabel,
            "Entendi",
            "excedido: único botão 'Entendi', sem prosseguir"
        );
        assert.strictEqual(lastAskProps.cancelLabel, undefined, "excedido: sem botão cancelar/prosseguir");
        console.log("✓ B1: excedido → HARD BLOCK (super não chamado, botão só 'Entendi')");
    }

    // B2: excedido não avança mesmo se ask resolver true
    {
        askResult = true;
        const order = makeOrder({ hasPayLater: true, total: 11, partner: { id: 1, name: "A" } });
        const ctx = makeThis({ order });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, false, "excedido bloqueia independente do retorno do ask");
        console.log("✓ B2: excedido não avança mesmo se operador clicar 'Entendi'");
    }

    // ── Grupo C: validateOrder — sem_limite é HARD BLOCK (DEC-C) ─────────────

    // C1: sem_limite → não avança mesmo com ask resolvendo true
    {
        askResult = true;
        const order = makeOrder({ hasPayLater: true, total: 10, partner: { id: 2, name: "B" } });
        const ctx = makeThis({ order });
        // força limite zero
        ctx.env.services.orm.call = () => Promise.resolve({ credit: 0, credit_limit: 0 });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, false, "sem_limite deve BLOQUEAR super.validateOrder()");
        assert.strictEqual(order.__setToInvoice, false, "sem_limite não marca to_invoice");
        assert(lastAskProps, "deve abrir modal");
        assert.strictEqual(
            lastAskProps.title,
            "⚠️ Cliente Sem Limite a Prazo",
            "título do modal sem_limite"
        );
        assert.strictEqual(lastAskProps.confirmLabel, "Entendi", "sem_limite: único botão 'Entendi'");
        assert.strictEqual(lastAskProps.cancelLabel, undefined, "sem_limite: sem botão de prosseguir");
        console.log("✓ C1: sem_limite → HARD BLOCK (botão só 'Entendi')");
    }

    // C2: sem_limite não avança mesmo se o operador clicar "Entendi"
    {
        askResult = false;
        const order = makeOrder({ hasPayLater: true, total: 10, partner: { id: 2, name: "B" } });
        const ctx = makeThis({ order });
        ctx.env.services.orm.call = () => Promise.resolve({ credit: 0, credit_limit: 0 });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, false, "sem_limite bloqueia independente do ask");
        assert.strictEqual(order.__setToInvoice, false, "sem_limite não marca to_invoice");
        console.log("✓ C2: sem_limite não avança nem clicando 'Entendi'");
    }

    // ── Grupo D: validateOrder — ok → avança + to_invoice=true ──────────────

    // D1: dentro do limite chama super e marca to_invoice
    {
        askResult = true;
        const order = makeOrder({ hasPayLater: true, total: 10, partner: { id: 3, name: "C" } });
        const ctx = makeThis({ order });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, true, "ok deve chamar super.validateOrder()");
        assert.deepStrictEqual(ctx.__superArgs, [false], "super recebe o argumento original");
        assert.strictEqual(order.__setToInvoice, true, "ok marca to_invoice=true");
        assert.strictEqual(lastAskProps, null, "ok não abre modal de limite");
        console.log("✓ D1: ok → super chamado + to_invoice=true");
    }

    // D2: sem pay_later não consulta ORM e segue normalmente
    {
        askResult = true;
        let ormCalled = false;
        const order = makeOrder({ hasPayLater: false, total: 10, partner: { id: 4, name: "D" } });
        const ctx = makeThis({ order });
        const originalCall = ctx.env.services.orm.call.bind(ctx.env.services.orm);
        ctx.env.services.orm.call = (...args) => {
            ormCalled = true;
            return originalCall(...args);
        };
        await runValidate(ctx);
        assert.strictEqual(ormCalled, false, "sem pay_later não consulta ORM");
        assert.strictEqual(ctx.__superCalled, true, "sem pay_later avança normalmente");
        assert.strictEqual(order.__setToInvoice, false, "sem pay_later não marca to_invoice");
        console.log("✓ D2: sem pay_later → ORM não consultado, avança sem to_invoice");
    }

    // D3: com pay_later mas sem cliente → segue para super (comportamento atual)
    {
        askResult = true;
        const order = makeOrder({ hasPayLater: true, total: 10, partner: null });
        const ctx = makeThis({ order });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, true, "sem cliente segue para super");
        assert.strictEqual(order.__setToInvoice, true, "sem cliente ainda marca to_invoice (pay_later)");
        console.log("✓ D3: pay_later sem cliente → super chamado (comportamento atual)");
    }

    // ── Grupo E: validateOrder — ORM/rede failure → HARD BLOCK com pay_later ──

    // E1: falha na leitura do partner → não avança
    {
        askResult = true;
        const order = makeOrder({ hasPayLater: true, total: 10, partner: { id: 5, name: "E" } });
        const ctx = makeThis({ order, ormThrows: true });
        await runValidate(ctx);
        assert.strictEqual(ctx.__superCalled, false, "falha ORM com pay_later deve BLOQUEAR super.validateOrder()");
        assert.strictEqual(order.__setToInvoice, false, "falha ORM não marca to_invoice");
        assert(lastAskProps, "deve abrir modal informativo de falha");
        assert(
            /indisponível|não será emitida/.test(lastAskProps.body || ""),
            "body explica que a compra a prazo não será emitida"
        );
        assert.strictEqual(lastAskProps.confirmLabel, "Entendi", "falha: botão único 'Entendi'");
        assert.strictEqual(lastAskProps.cancelLabel, undefined, "falha: sem botão de prosseguir");
        console.log("✓ E1: falha ORM/rede com pay_later → HARD BLOCK + modal informativo");
    }

    // E2: o fluxo faz UMA chamada e NÃO usa searchRead (limite vem do contato)
    {
        askResult = true;
        const chamadas = [];
        const order = makeOrder({ hasPayLater: true, total: 10, partner: { id: 6, name: "F" } });
        const ctx = makeThis({ order });
        ctx.env.services.orm.call = (model, method, args) => {
            chamadas.push([model, method, args]);
            return Promise.resolve({ credit: 0, credit_limit: 200 });
        };
        await runValidate(ctx);
        assert.deepStrictEqual(
            chamadas,
            [["res.partner", "prazo_limite_credito", [6]]],
            "deve ser UMA chamada ao seam do contato (nome público)"
        );
        assert.strictEqual(ctx.__superCalled, true, "ok com limite do contato avança");
        console.log("✓ E2: uma única chamada ao seam do contato, sem searchRead");
    }

    // ── Grupo F: contrato do manifest ────────────────────────────────────────

    // F1: arquivo está no bundle POS, mas o teste não
    {
        const start = manifest.indexOf("'point_of_sale._assets_pos'");
        const end = manifest.indexOf("'web.assets_web'");
        assert(start !== -1 && end > start, "não achou bloco point_of_sale._assets_pos");
        const block = manifest.slice(start, end);
        assert(
            block.includes("static/src/js/auto_invoice_pay_later.js"),
            "auto_invoice_pay_later.js deve estar em point_of_sale._assets_pos"
        );
        assert(
            !manifest.includes("tests/test_auto_invoice_pay_later.js"),
            "teste Node não vai no manifest"
        );
        assert(
            !source.includes("hr.employee") && !source.includes("x_limite_prazo"),
            "o PDV não pode mais ler limite de funcionário"
        );
        assert(
            source.includes('"prazo_limite_credito"'),
            "o PDV deve ler o limite pelo seam do contato (nome público)"
        );
        assert(
            !source.includes('"_prazo_limite_credito"'),
            "método com _ é rejeitado pelo RPC (get_public_method) — não pode voltar"
        );
        console.log("✓ F1: JS no bundle POS; teste fora do manifest; sem hr.employee");
    }

    console.log("\nTodos os testes passaram ✓");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
