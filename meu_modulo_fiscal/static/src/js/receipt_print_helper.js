/** @odoo-module */
// Helper compartilhado de impressão de recibos térmicos.
//
// Débito técnico I3: o fallback de impressão abre uma window nova via
// window.open() que NÃO herda os assets do bundle — por isso precisa do
// CSS inline no <head> do popup. Extraído do patch do ClosePosPopup
// (fechamento_button.js) para ser reutilizado pelo comprovante de
// pagamento (recebimento_button.js).
//
// TODO: eliminar quando o fallback suportar carregar assets externos na
// window nova (aí a fonte única passa a ser static/src/css/fechamento.css).
const RECEIPT_CSS = `
    /* Inconsolata — mesma fonte do cupom do consumidor final (POS).
       O bundle do POS declara este @font-face em
       point_of_sale/static/src/scss/pos.scss, mas o fallback abre uma window
       nova (about:blank) que NÃO herda o bundle: sem esta declaração o browser
       cai em 'Courier New', que imprime visivelmente mais fina/apagada na
       térmica. URL absoluta porque about:blank não resolve caminho relativo.
       Espelhado em static/src/css/fechamento.css (fonte única do CSS). */
    @font-face {
        font-family: 'Inconsolata';
        src: url('/point_of_sale/static/src/fonts/Inconsolata.otf') format('opentype');
        font-weight: normal;
        font-style: normal;
    }

    .pos-receipt {
        font-family: 'Inconsolata', 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.3;
        width: 72mm;
        margin: 0 auto;
        padding: 1mm 3mm;
        /* Sem isto o browser "otimiza" o preto para a térmica e clareia o texto */
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
    }
    .danfe-header { text-align: center; margin-bottom: 8px; }
    .emitente-nome { font-weight: bold; font-size: 13px; margin-bottom: 3px; }
    .emitente-dados { font-size: 10px; line-height: 1.2; }
    .emitente-endereco { font-size: 10px; line-height: 1.3; margin-top: 3px; }
    .danfe-tipo { text-align: center; font-weight: bold; font-size: 11px; margin: 8px 0; line-height: 1.4; }
    .danfe-separador { border-top: 1px dashed #000; margin: 5px 0; }
    .totais-section { margin: 8px 0; }
    .pagamento-titulo { font-weight: bold; text-align: center; margin-bottom: 4px; }
    .fiscal-section { margin-top: 10px; text-align: center; }

    /* Linha com label + valor (estilo cupom tradicional) */
    .fechamento-linha {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin: 1px 0;
        font-size: 11px;
    }
    .fechamento-linha span:first-child {
        white-space: nowrap;
        overflow: hidden;
    }
    .fechamento-linha .total-valor {
        white-space: nowrap;
        text-align: right;
        font-weight: normal;
    }
    /* Linha de total em destaque (negrito + borda superior) */
    .fechamento-linha-total {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-weight: bold;
        font-size: 12px;
        margin-top: 4px;
        padding-top: 3px;
        border-top: 1px solid #000;
    }
    .fechamento-linha-total .total-valor {
        text-align: right;
        font-weight: bold;
    }
    /* Linha de assinatura */
    .assinatura-area {
        margin-top: 30px;
        text-align: center;
    }
    .assinatura-linha {
        border-top: 1px solid #000;
        margin-top: 40px;
        padding-top: 3px;
        font-size: 10px;
        text-align: center;
    }

    @page { size: 72mm auto; margin: 0 2mm; }
    @media print {
        .pos-receipt { width: 70mm !important; font-size: 12px !important; padding: 0 2mm !important; margin: 0 auto !important; }
    }
`;

/**
 * Fallback de impressão quando não há impressora térmica disponível ou a
 * impressão falha: abre uma janela nova com o CSS do cupom inline e chama
 * window.print().
 *
 * @param {Element} el elemento DOM do recibo renderizado (renderToElement)
 * @param {string} title título da janela de impressão
 */
export function printFallback(el, title = "Recibo") {
    const win = window.open('', '_blank', 'width=400,height=600');
    if (!win) {
        console.error("[RECEIPT] Popup bloqueado pelo browser");
        return;
    }
    win.document.write(`
        <html>
        <head>
            <meta charset="utf-8">
            <title>${title}</title>
            <style>${RECEIPT_CSS}</style>
        </head>
        <body>${el.outerHTML}</body>
        </html>
    `);
    win.document.close();
    win.focus();
    // Espera a fonte estar carregada antes de imprimir: imprimir com a webfont
    // ainda pendente faz o browser usar Courier New (texto mais fino/apagado
    // na térmica). Fallback de 1s caso document.fonts não exista.
    const disparar = () => {
        win.print();
        win.close();
    };
    const fontsReady = win.document.fonts && win.document.fonts.ready;
    if (fontsReady) {
        Promise.race([
            win.document.fonts.ready,
            new Promise((r) => setTimeout(r, 1000)),
        ]).then(() => setTimeout(disparar, 100));
    } else {
        setTimeout(disparar, 250);
    }
}
