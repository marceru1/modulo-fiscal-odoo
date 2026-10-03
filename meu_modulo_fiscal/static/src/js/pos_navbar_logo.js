/** @odoo-module */
import { patch } from "@web/core/utils/patch";
import { Navbar } from "@point_of_sale/app/navbar/navbar";

/**
 * caixa-no-navbar-pdv: mostra o nome do caixa (pos.config.name) ao lado da
 * logo, no centro da navbar do PDV — identifica o terminal (Caixa 01, 02...)
 * num relance.
 *
 * O nome vem do `pos.config` que o POS já carrega inteiro no cache inicial:
 * em Odoo 18 o `PosConfig` herda `pos.load.mixin` sem definir
 * `_load_pos_data_fields`, então o mixin devolve `[]` e o `read` traz todos
 * os campos acessíveis — `name` está lá sem loader novo. `this.pos` já é
 * criado pelo setup do Navbar do core (usePos), então nenhum serviço/import
 * extra. O template (pos_navbar_logo.xml) renderiza o getter.
 */
patch(Navbar.prototype, {
    get caixaLabel() {
        const nome = this.pos?.config?.name;
        return typeof nome === "string" ? nome.trim() : "";
    },
});
