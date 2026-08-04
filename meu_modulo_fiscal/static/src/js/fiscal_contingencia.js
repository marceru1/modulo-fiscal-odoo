/** @odoo-module */

export async function sha1(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Calcula o Dígito Verificador (cDV) da chave de acesso NF-e/NFC-e.
 *
 * Padrão oficial SEFAZ (MOC - Manual de Orientação ao Contribuinte):
 *   - Módulo 11 com pesos 2..9 repetidos
 *   - Leitura da DIREITA para a ESQUERDA (dígito mais à direita recebe peso 2)
 *   - Se remainder < 2 → DV = 0
 *   - Caso contrário    → DV = 11 - remainder
 *
 * ⚠️  Bug anterior: o código percorria da ESQUERDA para DIREITA, produzindo
 *     um DV diferente do que a SEFAZ/Focus NFe calcula. O cupom impresso ficava
 *     com chave diferente da autorizada. (ERROR-011 / 2026-05-12)
 */
function calcularDigitoVerificador(chaveSemDV) {
    const pesos = [2, 3, 4, 5, 6, 7, 8, 9];
    let soma = 0;
    for (let i = 0; i < 43; i++) {
        // Percorre da direita para a esquerda: charAt(42) → charAt(0)
        soma += parseInt(chaveSemDV.charAt(42 - i)) * pesos[i % 8];
    }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto).toString();
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
 * 3 Camadas de Proteção contra Duplicidade (ERROR-010 / DEC-011):
 *   Camada 1: localStorage (rápido, mas volátil — pode ser limpo)
 *   Camada 2: seedFromSession (injetado na abertura do caixa, mas pode ficar stale)
 *   Camada 3: RPC em tempo real ao pos.config (fonte mais confiável, mas precisa de rede)
 *   Resultado final: Math.max(localStorage, seed, rpc) como piso.
 *
 * @param {object} order - Objeto do pedido do Odoo POS
 * @param {object} config - Configurações fiscais da empresa (pos.company)
 * @param {number} posConfigId - ID do pos.config do terminal atual
 * @param {number} seedFromSession - Maior número já emitido para esta série, vindo do
 *   backend no momento de abertura do caixa. Protege contra PC novo ou localStorage
 *   limpo. Use 0 como fallback seguro.
 * @param {object|null} orm - Serviço ORM do Odoo (env.services.orm). Se fornecido,
 *   tenta uma consulta em tempo real ao banco antes de emitir.
 */
export async function emitirContingencia(order, config, posConfigId, seedFromSession = 0, orm = null) {
    const cnpj = (config.x_cnpj || '').replace(/\D/g, '').padEnd(14, '0');
    const uf = config.x_uf_codigo || '13';
    const cscId = (config.x_csc_id || '').trim();
    const cscToken = (config.x_csc_token || '').trim();
    const ambiente = config.x_ambiente_fiscal || 'homologacao';
    const urlBase = ambiente === 'homologacao' ? config.x_url_qrcode_homolog : config.x_url_qrcode_producao;
    const tpAmb = ambiente === 'homologacao' ? '2' : '1';

    // ── Série por Caixa ──────────────────────────────────────────────────────
    // OFFLINE usa série 7xx (700 + ID), ONLINE usa série 6xx (600 + ID).
    // Namespaces completamente separados → zero colisão entre fluxos. (DEC-012)
    const serie = (700 + (posConfigId || 1)).toString();
    const STORAGE_KEY = `nfce_seq_${cnpj}_s${serie}`;
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"ultimo": 0}');

    // ── Camada 3: RPC em tempo real (última linha de defesa) ──────────────────
    // Mesmo que navigator.onLine diga "offline", o servidor Odoo pode estar
    // acessível na rede local. Tentamos uma consulta rápida ao banco para pegar
    // o contador real. Se falhar, caímos silenciosamente no localStorage + seed.
    let rpcUltimoNumero = 0;
    if (orm) {
        try {
            rpcUltimoNumero = await orm.call(
                "pos.config",
                "get_ultimo_numero_contingencia",
                [[posConfigId]]
            );
            console.log(`✅ [CONTINGENCIA-RPC] Contador em tempo real do banco: ${rpcUltimoNumero}`);
        } catch (e) {
            console.warn(`⚠️ [CONTINGENCIA-RPC] Sem acesso ao banco (offline real). Fallback: localStorage+seed.`, e.message);
        }
    }

    // Piso resiliente: o maior entre as 3 fontes vence.
    // localStorage=0 (PC novo) + seed=10 + rpc=15 → base=15 → próxima nota: 16 ✅
    // localStorage=20 (offline longo) + seed=10 + rpc=15 → base=20 → próxima nota: 21 ✅
    // localStorage=0 + seed=0 + rpc=0 (primeira vez) → base=0 → próxima nota: 1 ✅
    const base = Math.max(state.ultimo, seedFromSession, rpcUltimoNumero);
    const numero = base + 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ultimo: numero }));
    // ─────────────────────────────────────────────────────────────────────────

    const codigoUnico = Math.floor(10000000 + Math.random() * 90000000).toString(); // cNF (8 dígitos)

    // Data de emissão em America/Manaus (UTC-4), independente do timezone do browser.
    // Usa Intl.DateTimeFormat com timeZone para obter os componentes corretos do
    // fuso de Manaus em vez de hardcode -4h (mais robusto e respeita mudanças de
    // fuso oficiais, caso o estado altere seu offset no futuro).
    const agora = new Date();
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Manaus',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(agora).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});

    const ano = (parseInt(parts.year) % 100).toString().padStart(2, '0');
    const mes = parts.month;
    const dia = parts.day;
    const hora = parts.hour;
    const min = parts.minute;
    const seg = parts.second;
    const aamm = ano + mes;

    const dataEmissao = `${parts.year}-${mes}-${dia}T${hora}:${min}:${seg}-04:00`;

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
