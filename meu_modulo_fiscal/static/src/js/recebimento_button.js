/** @odoo-module */
import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { NumberPopup } from "@point_of_sale/app/utils/input_popups/number_popup";
import { PartnerList } from "@point_of_sale/app/screens/partner_list/partner_list";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";

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

        // ── 2. Ler saldo devedor do parceiro via ORM (res.partner.credit) ───────
        // O campo `credit` não é carregado no POS por padrão — leitura direta ao backend.
        let saldo = 0;
        try {
            const result = await this.orm.call(
                "res.partner",
                "read",
                [[selectedPartner.id], ["credit"]]
            );
            saldo = (result && result[0] && result[0].credit) || 0;
        } catch (e) {
            console.error("[RECEBIMENTO] Erro ao buscar saldo do parceiro:", e);
            this.notification.add("Erro ao consultar saldo do cliente.", { type: "danger" });
            return;
        }

        if (saldo <= 0) {
            this.notification.add(
                `${selectedPartner.name} não possui saldo devedor.`,
                { type: "warning" }
            );
            return;
        }

        // ── 3. Capturar valor via NumberPopup (pré-preenchido com o saldo) ──────
        const rawAmount = await makeAwaitable(this.dialog, NumberPopup, {
            title: `Recebimento — ${selectedPartner.name}`,
            subtitle: `Saldo devedor: ${this.env.utils.formatCurrency(saldo)}`,
            startingValue: saldo,
        });

        if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
            // Operador cancelou
            return;
        }

        // Converte o valor retornado pelo NumberPopup para float
        let valor;
        try {
            valor = this.env.utils.parseValidFloat
                ? this.env.utils.parseValidFloat(String(rawAmount))
                : parseFloat(String(rawAmount).replace(",", "."));
        } catch (_) {
            valor = parseFloat(String(rawAmount).replace(",", ".")) || 0;
        }

        if (!valor || valor <= 0 || isNaN(valor)) {
            this.notification.add("Valor inválido para recebimento.", { type: "warning" });
            return;
        }

        // ── 4. Chamar o backend para criar o account.payment ─────────────────────
        // O método Python create_recebimento(partner_id, amount) cria o pagamento
        // inbound, faz action_post() e reconcilia com as faturas abertas do parceiro.
        let response;
        try {
            this.env.services.ui.block({ message: "Registrando recebimento..." });
            response = await this.orm.call(
                "pos.session",
                "create_recebimento",
                [[this.pos.session.id], selectedPartner.id, valor]
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

        // ── 5. Exibir resultado ──────────────────────────────────────────────────
        if (response && response.success) {
            this.notification.add(
                `✅ ${response.message}`,
                { type: "success" }
            );
        } else {
            const msg = (response && response.message) || "Erro desconhecido no recebimento.";
            console.error("[RECEBIMENTO] Falha retornada pelo backend:", msg);
            this.notification.add(msg, { type: "danger" });
        }
    },
});
