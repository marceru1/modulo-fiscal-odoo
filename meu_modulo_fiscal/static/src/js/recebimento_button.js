/** @odoo-module */
import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { renderToElement } from "@web/core/utils/render";
import { PartnerList } from "@point_of_sale/app/screens/partner_list/partner_list";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";
import { makeAwaitable, ask } from "@point_of_sale/app/store/make_awaitable_dialog";
import { printFallback } from "./receipt_print_helper";

patch(Navbar.prototype, {
    setup() {
        super.setup();
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.orm = useService("orm");
    },

    async showRecebimento() {
        console.log("[RECEBIMENTO] Botao clicado");

        // ── 1. Selecionar cliente via PartnerList ───────────────────────────────
        const selectedPartner = await makeAwaitable(this.dialog, PartnerList, {
            partner: null,
        });

        if (!selectedPartner) {
            // Operador fechou o popup sem selecionar ninguém
            return;
        }

        // ── 2. Buscar faturas em aberto do parceiro via ORM ─────────────────────
        let invoices = [];
        try {
            invoices = await this.orm.call(
                "account.move",
                "search_read",
                [
                    [
                        ["partner_id", "=", selectedPartner.id],
                        ["move_type", "=", "out_invoice"],
                        ["payment_state", "in", ["not_paid", "partial"]],
                        ["state", "=", "posted"],
                    ],
                    ["name", "invoice_date_due", "amount_total", "amount_residual", "payment_state", "state"],
                    0,
                    50,
                    "invoice_date_due",
                ]
            );
        } catch (e) {
            console.error("[RECEBIMENTO] Erro ao buscar faturas:", e);
            this.notification.add("Erro ao consultar faturas do cliente.", { type: "danger" });
            return;
        }

        if (!invoices || invoices.length === 0) {
            this.notification.add(
                `Nenhuma fatura em aberto para ${selectedPartner.name}.`,
                { type: "warning" }
            );
            return;
        }

        // ── 3. Mostrar lista de faturas via SelectionPopup ──────────────────────
        // Formata cada fatura como label legível para o operador.
        const statusLabel = (state) => {
            if (state === "partial") return "Parcial";
            if (state === "not_paid") return "Em aberto";
            return state;
        };

        const formatDate = (isoDate) => {
            if (!isoDate) return "—";
            // isoDate: "2026-07-14"
            const [year, month, day] = isoDate.split("-");
            return `${day}/${month}/${year}`;
        };

        const formatCurrency = (amount) => {
            return "R$ " + Number(amount).toFixed(2).replace(".", ",");
        };

        const invoiceItems = invoices.map((inv) => ({
            id: inv.id,
            label: `${inv.name} — ${formatDate(inv.invoice_date_due)} — ${formatCurrency(inv.amount_residual)} (${statusLabel(inv.payment_state)})`,
            item: inv,
        }));

        const selectedItem = await makeAwaitable(this.dialog, SelectionPopup, {
            title: `Faturas em aberto — ${selectedPartner.name}`,
            list: invoiceItems,
        });

        if (!selectedItem) {
            // Operador cancelou a seleção
            return;
        }

        const selectedInvoice = selectedItem;
        const amountResidual = selectedInvoice.amount_residual;

        // ── 4. NumberPopup para digitar o valor a receber ────────────────────
        // Repete até obter um valor válido ou o operador cancelar.
        let amount = null;
        while (true) {
            const rawValue = await makeAwaitable(this.dialog, NumberPopup, {
                title: `Valor a receber — ${selectedInvoice.name}`,
                startingValue: amountResidual.toFixed(2),
                confirmText: "OK",
                cancelText: "Cancelar",
            });

            if (!rawValue) {
                // Operador cancelou o NumberPopup
                return;
            }

            // Converte e arredonda para 2 casas (mesma precisão enviada ao backend)
            const parsed = parseFloat(rawValue);
            if (isNaN(parsed)) {
                this.notification.add("Valor inválido. Digite um número.", { type: "warning" });
                continue;
            }

            amount = Math.round(parsed * 100) / 100;

            if (amount <= 0) {
                this.notification.add("Valor inválido. Digite um valor maior que zero.", { type: "warning" });
                continue;
            }

            // Validação client-side (alinhada com o backend: tolerância de R$ 0,001)
            if (amount < 1.0) {
                this.notification.add("Valor mínimo de R$ 1,00", { type: "warning" });
                continue;
            }

            if (amount > amountResidual + 0.001) {
                this.notification.add("Valor superior ao saldo da fatura (R$ " + amountResidual.toFixed(2) + ")", { type: "warning" });
                continue;
            }

            break;
        }

        // ── 5. Selecionar a forma de pagamento (DEC-001) ───────────────────────
        // Métodos configurados no caixa, excluindo pay_later (DEC-003):
        // recebimento de fatura não gera NFC-e, então não usa os métodos fiscais.
        const paymentMethods = this.pos.payment_methods.filter(
            (pm) => pm.type !== "pay_later"
        );

        if (paymentMethods.length === 0) {
            this.notification.add(
                "Nenhuma forma de pagamento disponível no caixa.",
                { type: "warning" }
            );
            return;
        }

        const methodItems = paymentMethods.map((pm) => ({
            id: pm.id,
            label: pm.name,
            item: pm,
        }));

        const selectedMethodItem = await makeAwaitable(this.dialog, SelectionPopup, {
            title: "Forma de Pagamento",
            list: methodItems,
        });

        if (!selectedMethodItem) {
            // Operador cancelou a seleção do método
            return;
        }

        const selectedMethod = selectedMethodItem;

        // ── 6. Confirmar pagamento com valor + método + fatura ─────────────────
        const confirmed = await ask(this.dialog, {
            title: "Confirmar Recebimento",
            body: `Confirma o pagamento de ${formatCurrency(amount)} via ${selectedMethod.name} da fatura ${selectedInvoice.name}? (Saldo em aberto: ${formatCurrency(amountResidual)})`,
            confirmText: "Confirmar",
            cancelText: "Cancelar",
        });

        if (!confirmed) {
            return;
        }

        // ── 7. Chamar o backend para criar e reconciliar o account.payment ────
        let response;
        try {
            this.env.services.ui.block({ message: "Registrando recebimento..." });
            response = await this.orm.call(
                "pos.session",
                "create_recebimento",
                [
                    [this.pos.session.id],
                    selectedInvoice.id,
                    Math.round(amount * 100) / 100,
                    // payment_method_name (legado, mantido para compat retrógrada)
                    "",
                    // payment_method_id (novo, DEC-001): int do método escolhido
                    selectedMethod.id,
                ]
            );
        } catch (e) {
            console.error("[RECEBIMENTO] Erro ao registrar recebimento:", e);
            this.notification.add(
                "Erro ao registrar recebimento. Verifique a conexão e tente novamente.",
                { type: "danger" }
            );
            return;
        } finally {
            this.env.services.ui.unblock();
        }

        // ── 8. Exibir resultado ──────────────────────────────────────────────────
        if (response && response.success) {
            // DEC-002: popup de sucesso com "Reimprimir" em vez de notification
            // (notification não tem ação secundária).
            try {
                await this._printComprovante(response.comprovante);
            } catch (e) {
                console.error("[COMPROVANTE] Erro ao imprimir comprovante:", e);
            }
            const reprint = await ask(this.dialog, {
                title: "Pagamento registrado",
                // formatCurrency já inclui o prefixo "R$ " — sem prefixo duplicado
                body: `${formatCurrency(amount)} — Fatura ${selectedInvoice.name}`,
                confirmText: "OK",
                cancelText: "Reimprimir",
            });
            if (reprint === false && response.comprovante) {
                // Reimprimir sem nova RPC (re-render + print)
                await this._printComprovante(response.comprovante);
            }
        } else {
            const msg = (response && response.message) || "Erro desconhecido no recebimento.";
            console.error("[RECEBIMENTO] Falha retornada pelo backend:", msg);
            this.notification.add(msg, { type: "danger" });
        }
    },

    /**
     * Monta os dados do comprovante, renderiza o template OWL e imprime na
     * térmica (com fallback window.print via printFallback). Retorna o elemento
     * DOM renderizado — permite reimpressão sem nova RPC (DEC-002).
     *
     * Reutiliza o mesmo mecanismo do fechamento de caixa: renderToElement +
     * printer.printReceipt + printFallback (Boundary "Always do" da spec).
     */
    async _printComprovante(comprovante) {
        const data = {
            empresa: {
                nome: this.pos.company.name || '',
                cnpj: this.pos.company.x_cnpj || '',
                endereco_linha1: this.pos.company.x_endereco_linha1 || '',
                endereco_linha2: this.pos.company.x_endereco_linha2 || '',
            },
            comprovante,
        };
        const report = renderToElement("meu_modulo.ComprovanteParcialReceipt", {
            data,
            formatCurrency: this.env.utils.formatCurrency,
        });
        const printer = this.hardwareProxy.printer;
        if (printer) {
            const { successful } = await printer.printReceipt(report);
            if (!successful) {
                console.warn("[COMPROVANTE] Impressora falhou, usando window.print");
                printFallback(report, "Comprovante de Pagamento");
            }
        } else {
            console.log("[COMPROVANTE] Sem impressora, usando window.print");
            printFallback(report, "Comprovante de Pagamento");
        }
        return report;
    },
});
