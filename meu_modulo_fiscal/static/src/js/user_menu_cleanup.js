/** @odoo-module */

import { UserMenu } from "@web/webclient/user_menu/user_menu";
import { patch } from "@web/core/utils/patch";

patch(UserMenu.prototype, {
    /**
     * @override
     * Filtra a lista de itens exibidos no menu principal do usuário.
     * Remove as opções indesejadas (Suporte, Integração, Meu Perfil, Conta Odoo.com, Instalar App).
     */
    getElements() {
        const elements = super.getElements();
        const forbiddenIds = [
            "support",                  // Suporte
            "web_tour.tour_enabled",    // Integração / Onboarding
            "settings",                 // Meu perfil (ID nativo do Odoo)
            "profile",                  // Meu perfil (ID que hr injeta)
            "account",                  // Minha conta Odoo.com
            "install_pwa"               // Instalar app
        ];
        return elements.filter(element => !forbiddenIds.includes(element.id));
    }
});
