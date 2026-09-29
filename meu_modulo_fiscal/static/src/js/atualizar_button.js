/** @odoo-module */

import { Navbar } from "@point_of_sale/app/navbar/navbar";
import { patch } from "@web/core/utils/patch";

patch(Navbar.prototype, {
    // Item "Atualizar" do menu sanduíche só aparece quando recarregar a página
    // é seguro: online e sem pedidos de contingência pendentes de sincronização.
    // Offline o POS já mostra o badge de aviso na navbar — o item some por
    // completo (não fica desabilitado) para eliminar a chance de clique
    // acidental e perda de pedido pendente.
    get canRefreshPOS() {
        const network = this.pos.data.network;
        return !network.offline && network.unsyncData.length === 0;
    },
});
