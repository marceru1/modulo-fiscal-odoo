/**
 * Teste unitário (Node puro, sem Odoo) do ticket 02 da feature
 * consulta-vendas-caixa-dia: client action Owl "Consulta de vendas".
 *
 * Valida o CONTRATO dos arquivos (o Odoo roda local, mas o componente não é
 * montado fora do backend):
 *   - XML do template bem-formado, t-esc (nunca t-raw)
 *   - action client cujo tag casa com o registry da tela
 *   - menu em Ponto de Venda → Relatórios, sem grupo restrito
 *   - dropdown lê pos.config em runtime (nada hardcoded de Caixa 1/2/3/Biju)
 *   - estados: calendário desabilitado sem caixa, Consultar bloqueado, loading
 *     sem consulta dupla, erro != vazio, resultado velho limpo ao trocar filtros
 *   - calendário próprio de multisseleção (dias avulsos): grid do mês, toggle,
 *     chips removíveis, Limpar, navegação de mês e limite de 31 dias
 *   - detalhe da venda abre read-only (create/edit/delete: false)
 *   - manifest: tela no web.assets_backend, NUNCA no bundle do POS
 *   - comportamento dos helpers puros (podeConsultar/formatarDias/celulasDoMes
 *     /podeMarcarDia/formatarData/mensagemErro)
 *
 * Rodar: node meu_modulo_fiscal/tests/test_consulta_vendas_caixa_dia_ui.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(p, "utf8");

const js = read(path.join(MODULE_ROOT, "static", "src", "js", "consulta_vendas_caixa_dia.js"));
const xml = read(path.join(MODULE_ROOT, "static", "src", "xml", "consulta_vendas_caixa_dia.xml"));
const views = read(path.join(MODULE_ROOT, "views", "consulta_vendas_caixa_dia_views.xml"));
const manifest = read(path.join(MODULE_ROOT, "__manifest__.py"));

const TAG = "meu_modulo_fiscal.consulta_vendas_caixa_dia";

// ── XML bem-formado: scanner de balanceamento de tags ─────────────────────
function assertBalancedTags(source) {
    const noComments = source.replace(/<!--[\s\S]*?-->/g, "");
    // Mascara o conteúdo de atributos: um "=>" dentro de um handler Owl
    // contém '>' e enganaria o scanner ingênuo de tags.
    const semAtributos = noComments
        .replace(/"[^"]*"/g, '""')
        .replace(/'[^']*'/g, "''");
    const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>/g;
    const stack = [];
    let m;
    while ((m = tagRe.exec(semAtributos))) {
        const [, closing, name, , selfClosing] = m;
        if (name.startsWith("?") || name.startsWith("!")) {
            continue;
        }
        if (closing) {
            const expected = stack.pop();
            assert.strictEqual(expected, name, `tag </${name}> fecha <${expected}>`);
        } else if (!selfClosing) {
            stack.push(name);
        }
    }
    assert.deepStrictEqual(stack, [], `tags não fechadas: ${stack.join(", ")}`);
}

/** Extrai o corpo de um getter ou método do componente (só a definição,
 *  ignorando chamadas como `this.metodo(arg)`). */
function extractBody(src, signature) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = src.match(new RegExp(`${escaped}\\s*\\{`));
    assert(match, `Não encontrou a definição de ${signature}`);
    const braceIdx = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = braceIdx; i < src.length; i++) {
        if (src[i] === "{") {
            depth++;
        } else if (src[i] === "}") {
            depth--;
            if (depth === 0) {
                return src.slice(braceIdx + 1, i);
            }
        }
    }
    throw new Error(`Corpo de ${signature} desbalanceado`);
}

// ── 1: XML do template bem-formado, sem entidades perigosas ───────────────
{
    assert(xml.startsWith("<?xml version="), "template deve começar com declaração XML");
    assertBalancedTags(xml);
    assert(/t-name="meu_modulo_fiscal\.ConsultaVendasCaixaDia"/.test(xml), "t-name do template");
    assert(!/&(middot|nbsp|bull|mdash|ndash|hellip);/.test(xml), "usar unicode literal, não entidades HTML");
    console.log("✓ 1: XML do template bem-formado");
}

// ── 2: registro da action client casa com o tag do action XML ─────────────
{
    assert(
        js.includes(`const TAG = "${TAG}"`),
        "JS deve declarar o TAG da client action"
    );
    assert(
        /registry\.category\("actions"\)\.add\(TAG, ConsultaVendasCaixaDia\)/.test(js),
        "componente deve ser registrado em registry.category('actions')"
    );
    assert(
        new RegExp(`<field name="tag">${TAG}</field>`).test(views),
        "ir.actions.client deve usar o mesmo tag do registry"
    );
    console.log("✓ 2: action client registrada com tag consistente");
}

// ── 3: menu em Ponto de Venda → Relatórios, sem grupo restrito ─────────────
{
    assert(
        /<menuitem[^>]*parent="point_of_sale\.menu_point_rep"/s.test(views),
        "menu deve ficar sob point_of_sale.menu_point_rep (Relatórios)"
    );
    assert(
        /<menuitem[^>]*name="Vendas por caixa e dia"/s.test(views),
        "nome do menu"
    );
    assert(!/<menuitem[^>]*groups=/.test(views), "menu não deve restringir grupo");
    console.log("✓ 3: menu em Relatórios, sem grupo restrito");
}

// ── 4: caixas lidos do cadastro em runtime, sem hardcode ──────────────────
{
    assert(
        /orm\.searchRead\(\s*"pos\.config"/.test(js),
        "dropdown deve ler pos.config via orm.searchRead"
    );
    assert(!/["']Caixa\s*[123]["']/.test(js + xml), "não hardcodar nomes de caixa");
    assert(!/["']Biju["']/i.test(js + xml), "não hardcodar o caixa Biju");
    assert(!/config_id\s*=\s*\d+|configId\s*=\s*\d+/.test(js), "não hardcodar id de caixa");
    console.log("✓ 4: caixas vêm do cadastro em runtime");
}

// ── 5: chamada do método server-side ───────────────────────────────────────
{
    assert(
        /orm\.call\(\s*"pos\.order",\s*"get_vendas_caixa_dia",\s*\[this\.state\.configIds,\s*this\.state\.dias,\s*this\.state\.metodosIds\]/.test(js),
        "deve chamar pos.order.get_vendas_caixa_dia com caixas, dias e formas de pagamento"
    );
    console.log("✓ 5: chama o método server-side do ticket 01");
}

// ── 6: estados da tela ─────────────────────────────────────────────────────
{
    // Abertura: orientação e nenhuma consulta automática.
    assert(
        (js + xml).includes("Marque um ou mais caixas e ao menos um dia para consultar as vendas"),
        "mensagem inicial (caixas no plural)"
    );
    assert(!/onWillStart\([^)]*consultar/.test(js), "não consultar ao abrir");

    // Ao menos um caixa marcado habilita o calendário.
    assert(/t-att-disabled="!state\.configIds\.length \|\| state\.carregando"/.test(xml),
        "calendário desabilitado sem caixa marcado");

    // Consultar habilita só com 1+ caixa, 1+ dia e nunca durante loading.
    assert(/get podeConsultar\(\)/.test(js), "getter podeConsultar");
    const podeConsultarBody = extractBody(js, "get podeConsultar()");
    assert(/configIds\.length/.test(podeConsultarBody), "Consultar exige ao menos um caixa");
    assert(/dias\.length/.test(podeConsultarBody), "Consultar exige ao menos um dia");
    assert(/!\s*this\.state\.carregando/.test(podeConsultarBody), "loading impede consulta");

    // Loading visível.
    assert(xml.includes("Consultando..."), "indicador de carregamento");

    // Erro != vazio.
    assert(/state\.erro = this\.mensagemErro\(error\)/.test(js), "erro tratado à parte");
    assert(xml.includes("Nenhuma venda encontrada para este caixa nos dias selecionados"),
        "mensagem de dias sem vendas");

    // Trocar filtro limpa o resultado velho.
    const limpar = extractBody(js, "alterouFiltros()");
    assert(/this\.state\.resultado = null/.test(limpar), "trocar filtro limpa resultado");
    assert(/toggleCaixa\(caixaId\)[\s\S]*alterouFiltros/.test(js), "marcar/desmarcar caixa limpa resultado");
    assert(/toggleDia\(data\)[\s\S]*alterouFiltros/.test(js), "marcar/desmarcar dia limpa resultado");
    assert(/limparDias\(\)[\s\S]*alterouFiltros/.test(js), "limpar dias limpa resultado");
    console.log("✓ 6: estados da tela cobertos");
}

// ── 7: detalhe da venda read-only ──────────────────────────────────────────
{
    assert(/res_model:\s*"pos\.order"/.test(js), "abre pos.order");
    assert(/flags:\s*\{\s*create:\s*false,\s*edit:\s*false,\s*delete:\s*false\s*\}/.test(js),
        "detalhe sem criar/editar/excluir");
    console.log("✓ 7: detalhe da venda read-only");
}

// ── 8: rodapé usa o resumo do servidor, não subtotal de página ────────────
{
    assert(/state\.resultado\.resumo\.quantidade/.test(xml), "rodapé usa resumo.quantidade");
    assert(/state\.resultado\.resumo\.totais/.test(xml), "rodapé usa total por moeda do resumo");
    assert(!/vendas\.length\s*[-+*/]/.test(xml), "não calcular total no cliente");
    console.log("✓ 8: rodapé usa o resumo server-side");
}

// ── 9: t-esc para dados (XSS) e nunca t-raw ────────────────────────────────
{
    assert(/t-esc=/.test(xml), "usar t-esc");
    assert(!/t-raw=/.test(xml), "nunca usar t-raw");
    console.log("✓ 9: t-esc, sem t-raw");
}

// ── 10: manifest — tela no backend, nunca no bundle do POS ────────────────
{
    assert(/views\/consulta_vendas_caixa_dia_views\.xml/.test(manifest), "views XML no data do manifest");
    const backendBlock = manifest.match(/'web\.assets_backend':\s*\[([\s\S]*?)\],/);
    assert(backendBlock, "bloco web.assets_backend");
    assert(
        backendBlock[1].includes("consulta_vendas_caixa_dia.js")
        && backendBlock[1].includes("consulta_vendas_caixa_dia.xml"),
        "JS e XML do template em web.assets_backend"
    );
    const posBlock = manifest.match(/'point_of_sale\._assets_pos':\s*\[([\s\S]*?)\],/);
    assert(posBlock && !posBlock[1].includes("consulta_vendas_caixa_dia"), "não tocar no bundle do POS");
    console.log("✓ 10: assets só no backend, POS intocado");
}

// ── 11: comportamento dos helpers puros ────────────────────────────────────
{
    const podeConsultar = (state) =>
        new Function(extractBody(js, "get podeConsultar()")).call({ state });
    assert.strictEqual(podeConsultar({ configIds: [], dias: [], carregando: false }), false);
    assert.strictEqual(podeConsultar({ configIds: [1], dias: [], carregando: false }), false);
    assert.strictEqual(podeConsultar({ configIds: [], dias: ["2026-10-20"], carregando: false }), false);
    assert.strictEqual(podeConsultar({ configIds: [1], dias: ["2026-10-20"], carregando: true }), false);
    assert.strictEqual(podeConsultar({ configIds: [1], dias: ["2026-10-20"], carregando: false }), true);
    assert.strictEqual(
        podeConsultar({ configIds: [1, 2], dias: ["2026-10-20", "2026-10-24"], carregando: false }),
        true
    );

    const comp = {
        formatarData: new Function("data", extractBody(js, "formatarData(data)")),
        listar: new Function("itens", extractBody(js, "listar(itens)")),
    };
    assert.strictEqual(comp.formatarData("2026-10-20"), "20/10/2026");
    assert.strictEqual(comp.formatarData(""), "");

    const formatarDias = new Function(
        "datas", extractBody(js, "formatarDias(datas)")
    ).bind(comp);
    assert.strictEqual(formatarDias([]), "");
    assert.strictEqual(formatarDias(["2026-10-20"]), "20/10/2026");
    assert.strictEqual(
        formatarDias(["2026-10-24", "2026-10-15", "2026-10-20"]),
        "15, 20 e 24/10/2026"
    );
    assert.strictEqual(
        formatarDias(["2026-11-05", "2026-10-20"]),
        "20/10/2026 e 05/11/2026"
    );

    const mensagemErro = new Function(
        "error", "_t", extractBody(js, "mensagemErro(error)")
    );
    const identidade = (texto) => texto;
    assert.strictEqual(
        mensagemErro({ data: { message: "Caixa não encontrado ou sem acesso." } }, identidade),
        "Caixa não encontrado ou sem acesso."
    );
    assert.strictEqual(mensagemErro({ message: "Falha de rede" }, identidade), "Falha de rede");
    assert.strictEqual(
        mensagemErro({}, identidade),
        "Não foi possível consultar as vendas."
    );
    console.log("✓ 11: helpers puros com comportamento correto");
}

// ── 12: calendário próprio de multisseleção (dias avulsos) ────────────────
{
    // O <input type="date"> de um dia só saiu de cena.
    assert(!/<input[^>]*type="date"/.test(xml), "sem input type=date (multisseleção)");

    // Grid do mês com cada dia clicável (toggle) e dia marcado destacado.
    assert(/t-foreach="linhasDoMes"/.test(xml), "grid do mês renderizado");
    assert(/t-on-click="\(\) => this\.toggleDia\(celula\.data\)"/.test(xml), "cada dia é clicável");
    assert(/celula\.marcado/.test(xml), "dia marcado destacado");
    assert(/mudarMes\(-1\)/.test(xml) && /mudarMes\(1\)/.test(xml), "navegação de mês");

    // Chips dos dias marcados removíveis + Limpar.
    assert(/t-foreach="state\.dias"/.test(xml), "chips dos dias marcados");
    assert(/formatarData\(dia\)/.test(xml), "chip mostra o dia");
    assert(/toggleDia\(dia\)/.test(xml), "chip removível individualmente");
    assert(/t-on-click="limparDias"/.test(xml), "botão Limpar");
    assert(xml.includes(">Limpar<"), "rótulo Limpar");

    // Limite de 31 dias na UI, com mensagem.
    assert(/const LIMITE_DIAS = 31/.test(js), "limite de 31 dias no cliente");
    assert(js.includes("Selecione no máximo 31 dias por consulta."), "mensagem do limite");
    assert(/state\.aviso/.test(xml), "aviso do limite visível na tela");

    // Cálculo puro do grid: alinhamento, marcação e linha final completa.
    const celulasDoMes = new Function(
        "ano", "mes", "diasMarcados", extractBody(js, "celulasDoMes(ano, mes, diasMarcados)")
    );
    const outubro = celulasDoMes(2026, 10, ["2026-10-20"]);
    assert.strictEqual(outubro.length % 7, 0, "grid fecha em semanas completas");
    // 01/10/2026 é quinta-feira → 4 células vazias antes do dia 1.
    assert.deepStrictEqual(outubro.slice(0, 4), [null, null, null, null], "alinhamento do 1º dia");
    assert.strictEqual(outubro[4].dia, 1);
    assert.strictEqual(outubro[4].data, "2026-10-01");
    assert.strictEqual(outubro[4].marcado, false);
    const dia20 = outubro.find((celula) => celula && celula.data === "2026-10-20");
    assert.strictEqual(dia20.marcado, true, "dia marcado no grid");
    assert.strictEqual(celulasDoMes(2026, 10, []).filter(Boolean).length, 31);

    const corpoPodeMarcarDia = extractBody(js, "podeMarcarDia(diasMarcados, data)");
    const podeMarcarDia = (diasMarcados, data) =>
        new Function("diasMarcados", "data", "LIMITE_DIAS", corpoPodeMarcarDia)(
            diasMarcados,
            data,
            31
        );
    const trintaEUmDias = Array.from(
        { length: 31 },
        (_, indice) => `2026-10-${String(indice + 1).padStart(2, "0")}`
    );
    assert.strictEqual(podeMarcarDia(trintaEUmDias, "2026-11-01"), false, "32º dia impedido");
    assert.strictEqual(podeMarcarDia(trintaEUmDias, "2026-10-01"), true, "dia já marcado pode desmarcar");
    assert.strictEqual(podeMarcarDia(trintaEUmDias.slice(1), "2026-11-01"), true, "31º dia permitido");
    console.log("✓ 12: calendário multisseleção com limite de 31 dias");
}

// ── 13: colunas da tabela (DEC-009) ───────────────────────────────────────
{
    const cabecalhos = [...xml.matchAll(/<thead>[\s\S]*?<\/thead>/g)].map((m) => m[0]);
    const cabecalho = cabecalhos.find((bloco) => bloco.includes("Data e hora"));
    assert(cabecalho, "cabeçalho da tabela de resultados");
    // Atributos podem conter '>' (ex.: t-if="...length > 1"), então o
    // casador de tags aceita valores entre quotes.
    const titulos = [...cabecalho.matchAll(/<th(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?>([\s\S]*?)<\/th>/g)]
        .map((casamento) => casamento[1].trim());
    assert.deepStrictEqual(
        titulos,
        ["Data e hora", "Caixa", "Venda / cupom", "Operador", "Valor total", "Forma de pagamento"],
        "colunas e ordem da DEC-009 + coluna condicional do Caixa (DEC-010)"
    );
    assert(!/venda\.cliente/.test(xml), "sem coluna Cliente");
    assert(!/venda\.situacao/.test(xml), "sem coluna Situação");
    assert(xml.includes("Forma de pagamento"), "cabeçalho da forma de pagamento");
    assert(/<td t-esc="venda\.formas_pagamento"\/>/.test(xml), "célula da forma de pagamento");

    const linha = xml.match(/<tr t-foreach="state\.resultado\.vendas"[\s\S]*?<\/tr>/);
    assert(linha, "linha de venda na tabela");
    assert.strictEqual(
        (linha[0].match(/<td/g) || []).length,
        6,
        "6 células no template (a do Caixa é condicional)"
    );
    console.log("✓ 13: colunas Data/hora, Caixa (condicional), Cupom, Operador, Valor, Pagamento");
}

// ── 14: multi-seleção de caixas (DEC-010) ────────────────────────────────
{
    // Checkboxes dos pos.config reais, lidos em runtime.
    assert(/t-foreach="state\.caixas"/.test(xml), "lista de caixas renderizada");
    assert(/type="checkbox"/.test(xml), "checkboxes no lugar do dropdown");
    assert(/t-on-change="\(\) => this\.toggleCaixa\(caixa\.id\)"/.test(xml),
        "marcar/desmarcar cada caixa");
    assert(/state\.configIds\.includes\(caixa\.id\)/.test(xml), "checkbox reflete a seleção");
    assert(!/<select/.test(xml), "dropdown de caixa único saiu de cena");
    assert(/orm\.searchRead\(\s*"pos\.config"/.test(js), "caixas lidos do cadastro (sem hardcode)");

    // Coluna Caixa só com 2+ caixas marcados; com 1 fica só no cabeçalho.
    assert(/<th scope="col" t-if="state\.resultado\.caixas\.length > 1">Caixa<\/th>/.test(xml),
        "cabeçalho da coluna Caixa condicional");
    assert(/<td t-if="state\.resultado\.caixas\.length > 1"/.test(xml),
        "célula Caixa condicional");
    assert(/t-esc="venda\.caixa"/.test(xml), "nome do caixa por linha");

    // Cabeçalho do resultado lista os caixas marcados.
    assert(/formatarNomes\(state\.resultado\.caixas\)/.test(xml),
        "cabeçalho lista os caixas consultados");

    const formatarNomes = new Function(
        "itens", extractBody(js, "formatarNomes(itens)")
    );
    assert.strictEqual(formatarNomes([]), "");
    assert.strictEqual(formatarNomes([{ nome: "Caixa 2" }]), "Caixa 2");
    assert.strictEqual(
        formatarNomes([{ nome: "Caixa 2" }, { nome: "Biju" }]),
        "Caixa 2 + Biju"
    );
    console.log("✓ 14: checkboxes de caixa, coluna condicional e cabeçalho");
}

// ── 15: filtro opcional por forma de pagamento (DEC-011) ─────────────────
{
    // Checkboxes dos pos.payment.method reais, lidos em runtime e por nome.
    assert(/orm\.searchRead\(\s*"pos\.payment\.method"/.test(js),
        "formas de pagamento lidas do cadastro em runtime");
    assert(/t-foreach="state\.metodos"/.test(xml), "lista de formas renderizada");
    assert(/t-on-change="\(\) => this\.toggleMetodo\(metodo\.id\)"/.test(xml),
        "marcar/desmarcar forma de pagamento");
    assert(/state\.metodosIds\.includes\(metodo\.id\)/.test(xml), "checkbox reflete a seleção");
    assert(/opcional/i.test(xml), "filtro identificado como opcional");

    // Opcional: não entra no podeConsultar (vazio = sem filtro).
    const podeConsultarBody = extractBody(js, "get podeConsultar()");
    assert(!/metodosIds/.test(podeConsultarBody), "formas não são obrigatórias para consultar");

    // Chamada envia o filtro e o resultado expõe o filtro aplicado.
    assert(/state\.metodosIds\]/.test(js), "filtro enviado ao servidor");
    assert(/state\.resultado\.formas\.length/.test(xml), "cabeçalho mostra o filtro quando ativo");
    assert(/Formas:/.test(xml), "rótulo Formas: no cabeçalho");
    assert(/formatarNomes\(state\.resultado\.formas\)/.test(xml), "nomes das formas aplicadas");

    // Marcar/desmarcar forma zera resultado antigo.
    assert(/toggleMetodo\(metodoId\)[\s\S]*alterouFiltros/.test(js),
        "mudar o filtro de formas limpa o resultado");

    // Filtro vazio não aparece no cabeçalho (t-if pelo length).
    assert(/t-if="state\.resultado\.formas\.length"/.test(xml),
        "sem filtro, cabeçalho não mostra Formas");
    console.log("✓ 15: filtro opcional por forma de pagamento");
}

console.log("\nTodos os contratos da tela de consulta passaram.");
