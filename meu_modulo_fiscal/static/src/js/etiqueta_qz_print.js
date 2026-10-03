/** @odoo-module */

import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";
import { Component, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

let _qzScriptPromise = null;

/**
 * Carrega o qz-tray.js uma vez (servido pelo próprio Odoo, em
 * /meu_modulo_fiscal/static/lib/qz-tray.js). O QZ Tray é um programa que roda
 * no Windows, na mesma máquina do navegador, e conversa com a impressora USB —
 * o navegador sozinho não alcança a impressora da loja.
 */
function loadQzTray() {
    if (window.qz) {
        return Promise.resolve(window.qz);
    }
    if (!_qzScriptPromise) {
        _qzScriptPromise = new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "/meu_modulo_fiscal/static/lib/qz-tray.js";
            s.onload = () => (window.qz ? resolve(window.qz) : reject(new Error("qz-tray.js carregou mas não expôs qz")));
            s.onerror = () => reject(new Error("não foi possível baixar o qz-tray.js do Odoo"));
            document.head.appendChild(s);
        });
    }
    return _qzScriptPromise;
}

/**
 * Imprime a etiqueta direto na impressora, pelo QZ Tray.
 *
 * O modo `pixel` é o que funciona nesta impressora: o modo `raw + pdf + ZPL`
 * reporta sucesso e não imprime nada. A rotação (180) e o tamanho da página
 * vêm do servidor, porque são a mesma decisão do layout da etiqueta.
 */
export class XQzPrintField extends Component {
    static template = "meu_modulo_fiscal.XQzPrintField";
    static props = { ...standardFieldProps };

    setup() {
        this.notification = useService("notification");
        this.state = useState({ printer: "", impressoras: [], busy: false, status: "" });
    }

    get wizard() {
        return this.props.record;
    }

    /**
     * Conecta ao QZ Tray.
     *
     * Não usa `qz.security.setPromise` — essa função NÃO existe na API (é
     * `setCertificatePromise`/`setSignaturePromise`) e o erro abortava a
     * impressão antes de conectar. O QZ Tray 2.2.6 conecta sem assinatura numa
     * sessão local: ele mostra o diálogo de permissão na primeira impressão.
     */
    async _connect(qz) {
        if (!qz.websocket.isActive()) {
            await qz.websocket.connect();
        }
    }

    /**
     * Lista as impressoras que o QZ Tray desta máquina enxerga e DEFINE A
     * SUGESTÃO conforme o formato escolhido no wizard (a loja tem uma fila
     * para confecção e outra para bijuteria):
     *   confeccao → fila "confecção"  |  bijuteria → fila "bijuteria"
     *   fallbacks: L42 (modelo), Elgin genérico.
     * Se o operador já escolheu uma na mão (dropdown), ela vence.
     */
    async _findPrinter(qz) {
        const printers = await qz.printers.find();
        const lista = Array.isArray(printers) ? printers : (printers ? [printers] : []);

        const formato = this.wizard.model.root.data.x_label_format || "";
        const sugestoes = [];
        if (formato === "confeccao") {
            sugestoes.push(/confec[cç]/i, /l42/i, /elgin/i);
        } else if (formato === "bijuteria") {
            sugestoes.push(/bijut/i, /l42/i, /elgin/i);
        } else {
            sugestoes.push(/confec[cç]/i, /bijut/i, /l42/i, /elgin/i);
        }

        const escolhida = this.state.printer ||
            sugestoes.map((re) => lista.find((n) => re.test(n))).find(Boolean) ||
            "";
        return { escolhida, lista };
    }

    /**
     * Preenche o dropdown com a lista REAL do QZ Tray (o servidor não vê as
     * impressoras USB — quem vê é o QZ Tray, na máquina que imprime).
     * A memória da última impressora usada fica no localStorage da máquina.
     */
    async _carregarImpressoras(qz) {
        try {
            const printers = await qz.printers.find();
            const lista = Array.isArray(printers) ? printers : (printers ? [printers] : []);
            this.state.impressoras = lista;
            if (!this.state.printer) {
                const lembrada = localStorage.getItem("etiqueta_impressora") || "";
                const formato = this.wizard.model.root.data.x_label_format || "";
                const { escolhida } = await this._findPrinter(qz);
                // Prioridade: sugestão do formato; se já imprimiu nesta máquina
                // antes, usa a lembrada — mas a sugestão do formato vence quando
                // difere (imprimir bijuteria na fila de confecção é o erro que
                // este seletor existe para evitar).
                const preferida = lembrada && formato === "" ? lembrada : escolhida;
                if (preferida) {
                    this.state.printer = preferida;
                }
            }
        } catch (_e) {
            this.state.impressoras = [];
        }
    }

    async onClick() {
        if (this.state.busy) {
            return;
        }
        this.state.busy = true;
        this.state.status = "salvando...";
        try {
            // SALVAR ANTES DE IMPRIMIR. O x_get_print_payload roda no servidor e
            // le o x_line_ids do BANCO — se as quantidades que o operador acabou
            // de digitar não forem gravadas, ele imprime o valor antigo (foi o
            // bug de "sempre sai 1 etiqueta": 1 e o default da linha).
            // urgentSave grava e mantem a janela aberta (save fecharia o dialogo).
            const saved = await this.wizard.model.root.urgentSave();
            if (saved === false) {
                throw new Error("não deu para salvar as quantidades — confira os campos");
            }

            const qz = await loadQzTray();
            await this._connect(qz);
            await this._carregarImpressoras(qz);

            this.state.status = "gerando o PDF...";
            const payload = await this.wizard.model.orm.call(
                this.wizard.resModel,
                "x_get_print_payload",
                [this.wizard.resId],
                { context: this.wizard.context }
            );

            const { lista } = await this._findPrinter(qz);
            const printer = this.state.printer;
            if (!printer) {
                // Mostra a LISTA REAL: sem isso o usuario so ve "nao achei" e nao
                // sabe se o QZ Tray nao devolveu nada ou se o nome nao casou.
                throw new Error(
                    lista.length
                        ? `nenhuma impressora de etiqueta na lista. O QZ Tray vê: ${lista.join(", ")}`
                        : "o QZ Tray não devolveu nenhuma impressora (ele está aberto e rodando neste PC?)"
                );
            }
            localStorage.setItem("etiqueta_impressora", printer);
            this.state.status = `enviando para ${printer}...`;
            const config = qz.configs.create(printer, {
                colorType: "blackwhite",
                units: "mm",
                size: payload.page,
                scaleContent: true,
            });
            await qz.print(config, [
                { type: "pixel", format: "pdf", flavor: "base64", data: payload.pdf_base64 },
            ]);

            this.state.status = `enviado para ${printer}`;
            this.notification.add(`Etiqueta enviada para ${printer}`, { type: "success" });
        } catch (e) {
            this.state.status = "falhou";
            this.notification.add(
                `Não deu para imprimir direto: ${e.message || e}. ` +
                    "Confira o QZ Tray aberto no PC da impressora, ou use o botão Imprimir (PDF).",
                { type: "danger", sticky: true }
            );
        } finally {
            this.state.busy = false;
        }
    }
}

registry.category("fields").add("x_qz_print", {
    component: XQzPrintField,
    displayName: "Imprimir direto (QZ Tray)",
    supportedTypes: ["boolean"],
});
