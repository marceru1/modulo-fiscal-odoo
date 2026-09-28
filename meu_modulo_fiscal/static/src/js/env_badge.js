/** @odoo-module **/

import { session } from "@web/session";
import { patch } from "@web/core/utils/patch";
import { NavBar } from "@web/webclient/navbar/navbar";

// Selo de ambiente de teste no navbar (badge laranja "TESTE").
// O valor vem do session_info ('environment_label') — injetado pelo
// models/ir_http.py deste módulo via env var ODOO_ENV_LABEL do container.
// String vazia (PROD) = selo não renderiza.
patch(NavBar.prototype, {
    setup() {
        super.setup(...arguments);
        this.environmentLabel = session.environment_label || "";
    },
});