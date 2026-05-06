/** @odoo-module */

export async function sha1(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calcula o Dígito Verificador da chave de acesso NF-e/NFC-e.
 * Padrão oficial SEFAZ: multiplicadores fixos da ESQUERDA para DIREITA,
 * com a sequência 2..9 repetida (começando pelo dígito mais à esquerda).
 *
 * ⚠️ NÃO confundir com Módulo 11 genérico (que vai da direita pra esquerda).
 */
function calcularDigitoVerificador(chaveSemDV) {
    const multiplicadores = [2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4,5,6,7,8,9,2,3,4];
    let soma = 0;
    for (let i = 0; i < 43; i++) {
        soma += parseInt(chaveSemDV.charAt(i)) * multiplicadores[i];
    }
    const resto = soma % 11;
    const dv = 11 - resto;
    return (dv >= 10 ? 0 : dv).toString();
}

/**
 * Emite uma NFC-e em contingência offline.
 *
 * Arquitetura de Série por Caixa:
 * Cada terminal POS usa uma série fiscal exclusiva derivada do seu ID.
 *   posConfigId = 1  → série 601
 *   posConfigId = 2  → série 602
 *   ...
 *   posConfigId = 10 → série 610
 *
 * Vantagem: numeração 100% sequencial por caixa, zero buracos,
 * zero inutilizações necessárias no fim do mês.
 *
 * @param {object} order - Objeto do pedido do Odoo POS
 * @param {object} config - Configurações fiscais da empresa (pos.company)
 * @param {number} posConfigId - ID do pos.config do terminal atual
 * @param {number} seedFromSession - Maior número já emitido para esta série, vindo do
 *   backend no momento de abertura do caixa. Protege contra PC novo ou localStorage
 *   limpo. Use 0 como fallback seguro.
 */
export async function emitirContingencia(order, config, posConfigId, seedFromSession = 0) {
    const cnpj = (config.x_cnpj || '').replace(/\D/g, '').padEnd(14, '0');
    const uf = config.x_uf_codigo || '13';
    const cscId = (config.x_csc_id || '').trim();
    const cscToken = (config.x_csc_token || '').trim();
    const ambiente = config.x_ambiente_fiscal || 'homologacao';
    const urlBase = ambiente === 'homologacao' ? config.x_url_qrcode_homolog : config.x_url_qrcode_producao;
    const tpAmb = ambiente === 'homologacao' ? '2' : '1';

    // ── Série por Caixa ──────────────────────────────────────────────────────
    // Cada terminal tem sua série exclusiva (600 + ID do POS).
    // O contador local é vinculado ao CNPJ + série, garantindo que mesmo que
    // o localStorage seja limpo, o próximo bloco de série não colide com outro
    // terminal.
    const serie = (600 + (posConfigId || 1)).toString();
    const STORAGE_KEY = `nfce_seq_${cnpj}_s${serie}`;
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"ultimo": 0}');

    // Piso resiliente: nunca emite um número abaixo do que já foi autorizado no banco.
    // localStorage=0 (PC novo) + seed=47 → base=47 → próxima nota: 48 ✅
    // localStorage=55 (offline longo) + seed=47 → base=55 → próxima nota: 56 ✅
    const base = Math.max(state.ultimo, seedFromSession);
    const numero = base + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ultimo: numero }));
    // ─────────────────────────────────────────────────────────────────────────

    const codigoUnico = Math.floor(10000000 + Math.random() * 90000000).toString(); // cNF (8 dígitos)

    // Data de emissão em UTC-4 (Manaus/AM), independente do timezone do browser.
    // agora.getTime() retorna ms desde o epoch (sempre UTC), então subtraímos 4h para obter Manaus.
    const agora = new Date();
    const pad = (n) => String(n).padStart(2, '0');

    const manausMs = agora.getTime() - (4 * 60 * 60 * 1000); // UTC - 4h = Manaus
    const dt = new Date(manausMs); // "fingimos" que é UTC pra usar os getters sem conversão

    const ano = (dt.getUTCFullYear() % 100).toString().padStart(2, '0');
    const mes = pad(dt.getUTCMonth() + 1);
    const dia = pad(dt.getUTCDate());
    const hora = pad(dt.getUTCHours());
    const min = pad(dt.getUTCMinutes());
    const seg = pad(dt.getUTCSeconds());
    const aamm = ano + mes;

    const dataEmissao = `${dt.getUTCFullYear()}-${mes}-${dia}T${hora}:${min}:${seg}-04:00`;

    const modelo = '65';
    const tpEmis = '9'; // 9 = Contingência offline da NFC-e

    // cUF(2) + AAMM(4) + CNPJ(14) + Mod(2) + Serie(3) + Nro(9) + tpEmis(1) + cNF(8) = 43 chars + DV(1) = 44
    const chaveSemDV = uf + aamm + cnpj + modelo + serie.padStart(3, '0') + numero.toString().padStart(9, '0') + tpEmis + codigoUnico;
    const dv = calcularDigitoVerificador(chaveSemDV);
    const chaveAcesso = chaveSemDV + dv;

    let qrcodeUrl = "";
    const valorTotal = order.get_total_with_tax();
    const versao = '2'; // 2 para QR Code 2.0

    if (cscId && cscToken) {
        // A NT exige que o cIdToken tenha 6 dígitos numéricos (com zeros à esquerda)
        const cscIdPadded = cscId.padStart(6, '0');
        
        const msgHash = `${chaveAcesso}|${versao}|${tpAmb}|${String(valorTotal.toFixed(2)).replace('.', '')}|${cscIdPadded}${cscToken}`;
        const hash = await sha1(msgHash);
        qrcodeUrl = `${urlBase}?p=${chaveAcesso}|${versao}|${tpAmb}|${cscIdPadded}|${hash.toUpperCase()}`;
    } else {
        qrcodeUrl = `${urlBase}?p=${chaveAcesso}|${versao}|${tpAmb}|1`;
    }

    let qrcodeB64 = "";
    if (window.QRious) {
        const qr = new window.QRious({
            value: qrcodeUrl,
            size: 300
        });
        const dataUrl = qr.toDataURL();
        qrcodeB64 = dataUrl.split(',')[1] || "";
    } else {
        console.warn("QRious lib not found! Cannot generate base64 QR Code.");
    }

    console.log(`✅ [CONTINGÊNCIA] Caixa ${posConfigId} | Série ${serie} | Nota ${numero} | Chave: ${chaveAcesso}`);

    return {
        numero,
        serie,
        codigoUnico,
        chaveAcesso,
        qrcodeUrl,
        qrcodeB64,
        dataEmissao,
    };
}
