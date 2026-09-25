/** @odoo-module */
import { Component, onMounted, useRef, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";

/**
 * Popup de CPF com validação client-side (front only).
 * Bloqueia a confirmação (Apply / ENTER) quando o CPF digitado é inválido,
 * impedindo que um CPF ruim chegue ao Focus NFe e tome uma rejeição da SEFAZ
 * ("Rejeicao: CPF do destinatario invalido").
 *
 * Regras combinadas no grill:
 * - Vazio é permitido (consumidor final sem identificação).
 * - Qualquer coisa digitada tem que ser um CPF válido (11 dígitos + DV).
 */
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
    }
    onMounted() {
        this.inputRef.el.focus();
        this.inputRef.el.select();
    }

    get cpfLimpo() {
        return (this.state.inputValue || "").replace(/\D/g, "");
    }
    get cpfValido() {
        return this.state.inputValue.trim() === "" || validarCpf(this.cpfLimpo);
    }
    get confirmDisabled() {
        return !this.cpfValido || this.state.confirmado;
    }
    get feedback() {
        const limpo = this.cpfLimpo;
        if (limpo.length === 0) return ""; // consumidor final, sem identificação
        if (limpo.length < 11) {
            return {
                type: "info",
                msg: `Faltam ${11 - limpo.length} dígito(s)...`,
            };
        }
        if (validarCpf(limpo)) {
            return { type: "ok", msg: "CPF válido" };
        }
        return { type: "erro", msg: "CPF inválido (confira os números)" };
    }

    onInput(ev) {
        // Máscara visual XXX.XXX.XXX-XX (só dígitos, cap em 11).
        // Feito manualmente (sem t-model) pra não depender da ordem dos
        // listeners do Owl e sincronizar o DOM na hora.
        const formatado = formatarCpf(ev.target.value);
        if (formatado !== ev.target.value) {
            ev.target.value = formatado;
        }
        this.state.inputValue = formatado;
        // Mensagem some assim que o operador corrige o valor.
        if (this.state.erro && this.cpfValido) {
            this.state.erro = "";
        }
    }

    onKeydown(ev) {
        if (ev.key.toUpperCase() === "ENTER") {
            ev.stopPropagation();
            if (this.confirmDisabled) {
                this.state.erro = this.cpfLimpo
                    ? _t("Informe 11 dígitos.")
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

    recusarCpf() {
        this.state.confirmado = true;
        this.props.getPayload(""); // consumidor final, sem CPF na nota
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
    if (typeof cpf !== "string" || cpf.length !== 11 || !/^\d{11}$/.test(cpf)) {
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
 * Máscara progressiva XXX.XXX.XXX-XX enquanto o operador digita.
 * Filtra não-dígitos e trava em 11 (o CPF não cresce além disso).
 * Retorna "" para null/undefined.
 */
export function formatarCpf(valor) {
    if (!valor) return "";
    const digitos = String(valor).replace(/\D/g, "").slice(0, 11);
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