/** @odoo-module */
import { Component, onMounted, useRef, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useHotkey } from "@web/core/hotkeys/hotkey_hook";
import { _t } from "@web/core/l10n/translation";

/**
 * Popup de CPF/CNPJ com validação client-side (front only).
 * Bloqueia a confirmação (Apply / ENTER) quando o documento digitado é inválido,
 * impedindo que um documento ruim chegue ao Focus NFe e tome uma rejeição da
 * SEFAZ ("Rejeicao: CPF/CNPJ do destinatario invalido", 539).
 *
 * Regras combinadas no grill:
 * - Vazio é permitido (consumidor final sem identificação).
 * - 11 dígitos → CPF (validação módulo 11 + DV).
 * - 14 dígitos → CNPJ (validação módulo 11 + DV).
 * - CNPJ vai como cnpj_destinatario na API Focus (nunca junto com cpf);
 *   indIEDest segue 9 (não contribuinte) — decisão do grill 29/09.
 */

/** Tipos aceitos pelo popup, derivados do total de dígitos. */
const CPF_DIGITOS = 11;
const CNPJ_DIGITOS = 14;

export class CpfInputPopup extends Component {
    static template = "meu_modulo_fiscal.CpfInputPopup";
    static components = { Dialog };
    static props = {
        title: String,
        startingValue: { type: String, optional: true },
        placeholder: { type: String, optional: true },
        getPayload: Function,
        close: Function,
    };
    static defaultProps = {
        startingValue: "",
        placeholder: "",
    };

    setup() {
        this.state = useState({
            inputValue: this.props.startingValue || "",
            erro: "",
            confirmado: false,
        });
        this.inputRef = useRef("input");
        onMounted(this.onMounted);

        // Esc = seguir sem documento, explícito (DEC-007). Antes o Esc caía no
        // Dialog.dismiss() -> onClose -> resolve() -> undefined, e o
        // confirm_popup.js coagia pra "" de qualquer forma — o resultado era o
        // mesmo, mas o popup não dizia o que queria. Aqui o Esc passa pelo mesmo
        // recusarDocumento() do botão "Não adicionar".
        // O core já abre exceção ao Esc na proteção de editável
        // (hotkey_service.js:186), então funciona com o input focado.
        useHotkey("escape", () => this.recusarDocumento());
    }
    onMounted() {
        this.inputRef.el.focus();
        this.inputRef.el.select();
    }

    get docLimpo() {
        return (this.state.inputValue || "").replace(/\D/g, "");
    }
    get docValido() {
        const limpo = this.docLimpo;
        return (
            this.state.inputValue.trim() === "" ||
            (limpo.length === CPF_DIGITOS && validarCpf(limpo)) ||
            (limpo.length === CNPJ_DIGITOS && validarCnpj(limpo))
        );
    }
    get confirmDisabled() {
        return !this.docValido || this.state.confirmado;
    }
    get feedback() {
        const limpo = this.docLimpo;
        if (limpo.length === 0) return ""; // consumidor final, sem identificação
        if (limpo.length < CPF_DIGITOS) {
            return {
                type: "info",
                msg: `Faltam ${CPF_DIGITOS - limpo.length} dígito(s)...`,
            };
        }
        if (limpo.length === CPF_DIGITOS) {
            return validarCpf(limpo)
                ? { type: "ok", msg: "CPF válido" }
                : { type: "erro", msg: "CPF inválido (confira os números)" };
        }
        if (limpo.length < CNPJ_DIGITOS) {
            return {
                type: "info",
                msg: `CNPJ: faltam ${CNPJ_DIGITOS - limpo.length} dígito(s)...`,
            };
        }
        return validarCnpj(limpo)
            ? { type: "ok", msg: "CNPJ válido" }
            : { type: "erro", msg: "CNPJ inválido (confira os números)" };
    }

    onInput(ev) {
        // Máscara visual progressiva (CPF XXX.XXX.XXX-XX até 11 dígitos,
        // depois XX.XXX.XXX/XXXX-XX até 14). Feito manualmente (sem t-model)
        // pra não depender da ordem dos listeners do Owl e sincronizar o DOM
        // na hora.
        const formatado = formatarDoc(ev.target.value);
        if (formatado !== ev.target.value) {
            ev.target.value = formatado;
        }
        this.state.inputValue = formatado;
        // Mensagem some assim que o operador corrige o valor.
        if (this.state.erro && this.docValido) {
            this.state.erro = "";
        }
    }

    onKeydown(ev) {
        if (ev.key.toUpperCase() === "ENTER") {
            ev.stopPropagation();
            if (this.confirmDisabled) {
                this.state.erro = this.docLimpo
                    ? _t("Informe 11 (CPF) ou 14 (CNPJ) dígitos.")
                    : "";
                return;
            }
            this.confirm();
        }
    }

    confirm() {
        if (this.confirmDisabled) return;
        this.state.confirmado = true; // trava duplo-clique / ENTER repetido
        this.props.getPayload(this.state.inputValue);
        this.props.close();
    }

    recusarDocumento() {
        this.state.confirmado = true;
        this.props.getPayload(""); // consumidor final, sem documento na nota
        this.props.close();
    }

    close() {
        this.props.close();
    }
}

/**
 * Valida CPF pelo algoritmo oficial da Receita Federal (módulo 11, 2 DVs).
 * Rejeita sequências repetidas (111.111.111-11 etc.) que passam no cálculo.
 */
export function validarCpf(cpf) {
    if (typeof cpf !== "string" || cpf.length !== CPF_DIGITOS || !/^\d{11}$/.test(cpf)) {
        return false;
    }
    if (/^(\d)\1{10}$/.test(cpf)) {
        return false;
    }
    let soma = 0;
    for (let i = 0; i < 9; i++) {
        soma += parseInt(cpf.charAt(i), 10) * (10 - i);
    }
    let resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    if (resto !== parseInt(cpf.charAt(9), 10)) {
        return false;
    }
    soma = 0;
    for (let i = 0; i < 10; i++) {
        soma += parseInt(cpf.charAt(i), 10) * (11 - i);
    }
    resto = (soma * 10) % 11;
    if (resto === 10) resto = 0;
    return resto === parseInt(cpf.charAt(10), 10);
}

/**
 * Valida CNPJ pelo algoritmo oficial da Receita Federal (módulo 11, pesos
 * 5432..9 e 6..9, 2 DVs). Rejeita sequências repetidas (11.111.111/1111-11).
 */
export function validarCnpj(cnpj) {
    if (typeof cnpj !== "string" || cnpj.length !== CNPJ_DIGITOS || !/^\d{14}$/.test(cnpj)) {
        return false;
    }
    if (/^(\d)\1{13}$/.test(cnpj)) {
        return false;
    }
    const calcDigito = (base, pesos) => {
        let soma = 0;
        for (let i = 0; i < base.length; i++) {
            soma += parseInt(base.charAt(i), 10) * pesos[i];
        }
        const resto = soma % 11;
        return resto < 2 ? 0 : 11 - resto;
    };
    const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const digito1 = calcDigito(cnpj.slice(0, 12), pesos1);
    if (digito1 !== parseInt(cnpj.charAt(12), 10)) {
        return false;
    }
    const digito2 = calcDigito(cnpj.slice(0, 13), pesos2);
    return digito2 === parseInt(cnpj.charAt(13), 10);
}

/**
 * Máscara progressiva enquanto o operador digita: CPF XXX.XXX.XXX-XX cap 11,
 * depois XX.XXX.XXX/XXXX-XX cap 14. Filtra não-dígitos.
 * Retorna "" para null/undefined.
 */
export function formatarDoc(valor) {
    if (!valor) return "";
    const d = String(valor).replace(/\D/g, "").slice(0, CNPJ_DIGITOS);
    if (d.length <= CPF_DIGITOS) {
        return formatarCpf(d);
    }
    return (
        `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    );
}

/**
 * Máscara progressiva CPF XXX.XXX.XXX-XX. Filtra não-dígitos e trava em 11.
 * Mantida com o nome público original (foi exportada antes do CNPJ).
 * Retorna "" para null/undefined.
 */
export function formatarCpf(valor) {
    if (!valor) return "";
    const digitos = String(valor).replace(/\D/g, "").slice(0, CPF_DIGITOS);
    let out = digitos;
    if (digitos.length > 9) {
        out = `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6, 9)}-${digitos.slice(9)}`;
    } else if (digitos.length > 6) {
        out = `${digitos.slice(0, 3)}.${digitos.slice(3, 6)}.${digitos.slice(6)}`;
    } else if (digitos.length > 3) {
        out = `${digitos.slice(0, 3)}.${digitos.slice(3)}`;
    }
    return out;
}