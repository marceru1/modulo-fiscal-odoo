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
    assert(/get calendarioHabilitado\(\)/.test(js), "getter do calendário habilitado");
    assert(/configIds\.length/.test(extractBody(js, "get calendarioHabilitado()")),
        "calendário exige caixa marcado");
    assert(/t-att-disabled="!calendarioHabilitado"/.test(xml),
        "navegação do calendário desabilitada sem caixa");

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
    assert(/o_consulta_dia_marcado/.test(xml), "dia marcado destacado");
    assert(/mudarMes\(-1\)/.test(xml) && /mudarMes\(1\)/.test(xml), "navegação de mês");

    // Chips dos dias marcados removíveis + Limpar dias.
    assert(/t-foreach="diasVisiveis"/.test(xml), "chips dos dias marcados");
    assert(/formatarDataCurta\(dia\)/.test(xml), "chip mostra o dia");
    assert(/t-on-click\.stop="\(\) => this\.removerDia\(dia\)"/.test(xml),
        "chip removível individualmente");
    assert(/t-on-click="limparDias"/.test(xml), "botão de limpar os dias");
    assert(xml.includes(">Limpar dias<"), "rótulo Limpar dias");

    // Limite de 31 dias na UI, com mensagem.
    assert(/const LIMITE_DIAS = 31/.test(js), "limite de 31 dias no cliente");
    assert(js.includes("Você já selecionou %s dias. Remova um dia para adicionar outro."),
        "mensagem do limite");
    assert(/state\.aviso/.test(xml), "aviso do limite visível na tela");

    // Cálculo puro do grid: alinhamento, marcação e linha final completa.
    const pad = (valor) => String(valor).padStart(2, "0");
    const celulasDoMes = new Function(
        "ano", "mes", "diasMarcados", "hojeISO", "duasCasas",
        extractBody(js, "celulasDoMes(ano, mes, diasMarcados, hojeISO)")
    );
    const outubro = celulasDoMes(2026, 10, ["2026-10-20"], undefined, pad);
    assert.strictEqual(outubro.length % 7, 0, "grid fecha em semanas completas");
    // 01/10/2026 é quinta-feira → 4 células vazias antes do dia 1.
    assert.deepStrictEqual(outubro.slice(0, 4), [null, null, null, null], "alinhamento do 1º dia");
    assert.strictEqual(outubro[4].dia, 1);
    assert.strictEqual(outubro[4].data, "2026-10-01");
    assert.strictEqual(outubro[4].marcado, false);
    const dia20 = outubro.find((celula) => celula && celula.data === "2026-10-20");
    assert.strictEqual(dia20.marcado, true, "dia marcado no grid");
    assert.strictEqual(celulasDoMes(2026, 10, [], undefined, pad).filter(Boolean).length, 31);

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

// ── 16: estrutura da tela e faixa de ação ──────────────────────────────────
{
    const scssPath = path.join(
        MODULE_ROOT, "static", "src", "css", "consulta_vendas_caixa_dia.scss"
    );
    assert(fs.existsSync(scssPath), "SCSS da consulta existe");
    const scss = read(scssPath);

    // Ordem de leitura: caixas -> dias -> pagamento -> faixa de ação.
    const posCaixas = xml.indexOf("o_consulta_grupo_caixas");
    const posDias = xml.indexOf("o_consulta_grupo_dias");
    const posPagamento = xml.indexOf("o_consulta_grupo_pagamento");
    const posAcao = xml.indexOf("o_consulta_acao");
    assert(posCaixas >= 0 && posDias >= 0 && posPagamento >= 0, "três grupos presentes");
    assert(posCaixas < posDias && posDias < posPagamento, "ordem caixas -> dias -> pagamento");
    assert(posAcao > posPagamento, "faixa de ação vem depois de todos os filtros");
    assert(
        /<div class="o_consulta_acao">[\s\S]*?Consultar[\s\S]*?<\/div>/.test(xml),
        "Consultar fica na faixa de ação"
    );

    // O calendário não é mais o dono da largura da tela.
    assert(/\.o_consulta_calendario_wrap\s*\{[\s\S]*?max-width:\s*380px/.test(scss),
        "calendário com largura limitada");
    assert(!/style="[^"]*width:\s*100%/.test(xml), "sem largura inline esticando o calendário");

    // Resumo da seleção e motivo visível.
    assert(/t-esc="resumoSelecao"/.test(xml), "resumo da seleção renderizado");
    assert(/t-if="motivoBloqueio"/.test(xml), "motivo do bloqueio visível");
    assert(xml.includes("Marque um ou mais caixas."), "texto auxiliar dos caixas");

    // Manifest: SCSS só no backend, nunca no bundle do POS.
    assert(
        /web\.assets_backend':\s*\[([\s\S]*?)consulta_vendas_caixa_dia\.scss/.test(manifest),
        "SCSS registrado em web.assets_backend"
    );
    const posBlock = manifest.match(/'point_of_sale\._assets_pos':\s*\[([\s\S]*?)\],/);
    assert(posBlock && !posBlock[1].includes("consulta_vendas_caixa_dia"), "SCSS fora do bundle do POS");

    // Escopo: o único seletor de topo é o wrapper da consulta (sem regra global).
    const semComentarios = scss.replace(/\/\/[^\n]*/g, "");
    const seletoresTopo = [...semComentarios.matchAll(/^([^\s@/][^{]*)\{/gm)]
        .map((casamento) => casamento[1].trim());
    assert.deepStrictEqual(seletoresTopo, [".o_consulta_vendas_caixa_dia"],
        "todo estilo fica sob .o_consulta_vendas_caixa_dia");
    assert(!/!important/.test(scss), "sem !important");

    // Comportamento do resumo (helpers puros + métodos do componente).
    const plural = new Function(
        "quantidade", "singular", "pluralTexto",
        extractBody(js, "plural(quantidade, singular, pluralTexto)")
    );
    assert.strictEqual(plural(1, "caixa", "caixas"), "caixa");
    assert.strictEqual(plural(2, "caixa", "caixas"), "caixas");
    assert.strictEqual(plural(0, "dia", "dias"), "dias");

    const identidade = (texto, ...args) =>
        args.reduce((acumulado, arg) => acumulado.replace("%s", arg), texto);
    const resumoPagamento = new Function(
        "_t", extractBody(js, "resumoPagamento()")
    );
    const comMetodos = (metodosIds, metodos) => ({
        state: { metodosIds, metodos },
        listar: (itens) => (itens.length <= 1
            ? itens[0] ?? ""
            : `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`),
    });
    assert.strictEqual(
        resumoPagamento.call(comMetodos([], []), identidade),
        "Sem filtro de pagamento"
    );
    assert.strictEqual(
        resumoPagamento.call(
            comMetodos([1, 2], [{ id: 1, name: "Dinheiro" }, { id: 2, name: "Cartão" }]),
            identidade
        ),
        "Pagamento: Dinheiro e Cartão"
    );
    assert.strictEqual(
        resumoPagamento.call(
            comMetodos([1, 2, 3], [
                { id: 1, name: "Dinheiro" },
                { id: 2, name: "Cartão" },
                { id: 3, name: "PIX" },
            ]),
            identidade
        ),
        "3 formas selecionadas"
    );
    assert.strictEqual(
        resumoPagamento.call(comMetodos([9], []), identidade),
        "1 formas selecionadas",
        "seleção preservada mesmo com o cadastro ainda não carregado"
    );

    const resumoSelecao = new Function(
        "plural", "_t", extractBody(js, "get resumoSelecao()")
    );
    const montar = (configIds, dias, metodosIds, metodos) => {
        const contexto = { state: { configIds, dias, metodosIds, metodos } };
        contexto.resumoPagamento = () => resumoPagamento.call(contexto, identidade);
        return contexto;
    };
    assert.strictEqual(
        resumoSelecao.call(montar([1, 2], ["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"], [], []), plural, identidade),
        "2 caixas · 5 dias · Sem filtro de pagamento"
    );
    assert.strictEqual(
        resumoSelecao.call(montar([1], ["2026-10-08"], [], []), plural, identidade),
        "1 caixa · 1 dia · Sem filtro de pagamento"
    );

    console.log("✓ 16: estrutura, faixa de ação e resumo da seleção");
}

// ── 17: carga de opções — carregando ≠ vazio ≠ erro ───────────────────────
{
    // Carga em andamento não aparece como ausência definitiva.
    assert(xml.includes("Carregando caixas e formas de pagamento…"),
        "mensagem de carga das opções");
    assert(/t-if="state\.carregandoCaixas"[\s\S]*?role="status"/.test(xml),
        "carga dos caixas anunciada como status");
    assert(/t-if="state\.carregandoMetodos"[\s\S]*?role="status"/.test(xml),
        "carga das formas anunciada como status");

    // Falha identifica o grupo e oferece recuperação.
    assert(/t-elif="state\.erroCaixas"[\s\S]*?Não foi possível carregar os caixas/.test(xml),
        "erro dos caixas identificado");
    assert(/t-elif="state\.erroMetodos"[\s\S]*?Não foi possível carregar as formas de pagamento/.test(xml),
        "erro das formas identificado");
    assert(xml.includes("Tentar carregar novamente"), "ação de nova tentativa");
    assert(/t-on-click="\(\) => this\.carregarCaixas\(\)"/.test(xml), "retry dos caixas");
    assert(/t-on-click="\(\) => this\.carregarMetodos\(\)"/.test(xml), "retry das formas");

    // Vazio após carga concluída tem mensagem própria.
    assert(xml.includes("Nenhum caixa disponível para seu usuário."),
        "ausência de caixas com mensagem específica");
    assert(xml.includes("Nenhuma forma de pagamento disponível."),
        "ausência de formas com mensagem específica");

    // Estado por grupo: flags separadas e erro não vira erro de consulta.
    assert(/carregandoCaixas:\s*true/.test(js) && /carregandoMetodos:\s*true/.test(js),
        "flags de carga por grupo começam ligadas");
    assert(/this\.state\.erroCaixas = this\.mensagemErro\(error\)/.test(js),
        "falha dos caixas guardada no grupo");
    assert(/this\.state\.erroMetodos = this\.mensagemErro\(error\)/.test(js),
        "falha das formas guardada no grupo");
    assert(/finally\s*\{\s*this\.state\.carregandoCaixas = false/.test(js),
        "carga dos caixas sempre termina");
    assert(/finally\s*\{\s*this\.state\.carregandoMetodos = false/.test(js),
        "carga das formas sempre termina");

    const podeConsultar = new Function(extractBody(js, "get podeConsultar()"));
    const estado = (extra = {}) => ({
        state: {
            configIds: [1],
            dias: ["2026-10-20"],
            carregando: false,
            carregandoCaixas: false,
            carregandoMetodos: false,
            erroCaixas: "",
            erroMetodos: "",
            ...extra,
        },
    });
    assert.strictEqual(podeConsultar.call(estado()), true);
    assert.strictEqual(podeConsultar.call(estado({ erroCaixas: "falhou" })), false,
        "falha de caixas bloqueia consulta");
    assert.strictEqual(podeConsultar.call(estado({ erroMetodos: "falhou" })), false,
        "falha de formas bloqueia consulta (filtro incompleto)");
    assert.strictEqual(podeConsultar.call(estado({ carregandoCaixas: true })), false,
        "consulta espera a carga dos caixas");
    assert.strictEqual(podeConsultar.call(estado({ carregandoMetodos: true })), false,
        "consulta espera a carga das formas");

    // Motivo visível acompanha cada bloqueio.
    const motivo = new Function("_t", extractBody(js, "get motivoBloqueio()"));
    const traduzir = (texto, ...args) =>
        args.reduce((acumulado, arg) => acumulado.replace("%s", arg), texto);
    const motivoCom = (extra = {}) => ({
        state: {
            configIds: [],
            dias: [],
            caixas: [],
            carregando: false,
            carregandoCaixas: false,
            carregandoMetodos: false,
            erroCaixas: "",
            erroMetodos: "",
            ...extra,
        },
    });
    assert.strictEqual(
        motivo.call(motivoCom({ carregandoCaixas: true }), traduzir),
        "Aguarde o carregamento das opções."
    );
    assert.strictEqual(
        motivo.call(motivoCom({ erroCaixas: "falhou" }), traduzir),
        "Não foi possível carregar os caixas. Tente carregar novamente."
    );
    assert.strictEqual(
        motivo.call(motivoCom({ erroMetodos: "falhou" }), traduzir),
        "Não foi possível carregar as formas de pagamento. Tente carregar novamente."
    );
    assert.strictEqual(
        motivo.call(motivoCom(), traduzir),
        "Nenhum caixa disponível para seu usuário."
    );
    assert.strictEqual(
        motivo.call(motivoCom({ caixas: [{ id: 1 }] }), traduzir),
        "Selecione ao menos um caixa."
    );
    assert.strictEqual(
        motivo.call(motivoCom({ caixas: [{ id: 1 }], configIds: [1] }), traduzir),
        "Selecione ao menos um dia."
    );
    assert.strictEqual(
        motivo.call(
            motivoCom({
                caixas: [{ id: 1 }],
                configIds: [1],
                dias: ["2026-10-20"],
            }),
            traduzir
        ),
        ""
    );
    console.log("✓ 17: carga de opções com estados e recuperação por grupo");
}

// ── 18: calendário acessível (grade ARIA, teclado e idioma) ────────────────
{
    const traduzir18 = (texto, ...args) =>
        args.reduce((acumulado, arg) => acumulado.replace("%s", arg), texto);

    // Grade com semântica e estados (APG Grid Pattern adaptado à multisseleção).
    assert(/role="grid"/.test(xml), "grade com role=grid");
    assert(/aria-multiselectable="true"/.test(xml), "grade multisseleção");
    assert(/role="gridcell"/.test(xml), "células como gridcell");
    assert(/role="columnheader"/.test(xml), "cabeçalhos de coluna");
    assert(/t-att-aria-selected="celula\.marcado \? 'true' : 'false'"/.test(xml),
        "aria-selected por célula");
    assert(/t-att-aria-current="celula\.hoje \? 'date' : null"/.test(xml),
        "hoje com aria-current");
    assert(/t-att-aria-label="nomeCompletoData\(celula\.data\)"/.test(xml),
        "data completa como nome acessível");
    assert(/t-att-tabindex="calendarioHabilitado and celula\.data === focoVisivel \? 0 : -1"/.test(xml),
        "roving tabindex (só a célula focada é tabulável)");
    assert(/t-on-keydown="onCalendarioKeydown"/.test(xml), "teclado tratado na grade");
    assert(js.includes("Selecione um caixa para escolher os dias."),
        "razão do calendário desabilitado");
    assert(/t-esc="mensagemCalendarioDesabilitado"/.test(xml),
        "razão renderizada junto ao calendário");
    assert(/id="o_consulta_mes_rotulo"[\s\S]*?aria-live="polite"/.test(xml),
        "mês anunciado ao navegar");
    assert(/class="o_consulta_contador" aria-live="polite"/.test(xml), "contador anunciado");

    // Idioma do Odoo, não o locale do navegador.
    assert(!/toLocaleDateString\(undefined/.test(js), "sem locale indefinido no mês");
    assert(/user\.lang/.test(js), "idioma vem de user.lang");
    assert(/import \{ user \} from "@web\/core\/user"/.test(js), "user importado do core");
    assert(/import \{[^}]*today[^}]*\} from "@web\/core\/l10n\/dates"/.test(js),
        "hoje vem do contexto de data do Odoo");
    assert(/t-foreach="rotulosSemana"/.test(xml), "rótulos da semana renderizados");

    // Helpers de data puros (sem fuso do navegador).
    const duasCasas = (valor) => String(valor).padStart(2, "0");
    const capitalizar = (texto) => texto.charAt(0).toUpperCase() + texto.slice(1);

    const somarDias = new Function(
        "dataISO", "dias", extractBody(js, "somarDias(dataISO, dias)")
    );
    assert.strictEqual(somarDias("2026-10-31", 1), "2026-11-01");
    assert.strictEqual(somarDias("2026-03-01", -1), "2026-02-28");
    assert.strictEqual(somarDias("2026-10-20", 7), "2026-10-27");

    const somarMeses = new Function(
        "dataISO", "meses", "duasCasas",
        extractBody(js, "somarMeses(dataISO, meses)")
    );
    const somarMesesCom = (data, meses) => somarMeses(data, meses, duasCasas);
    assert.strictEqual(somarMesesCom("2026-01-31", 1), "2026-02-28",
        "dia inexistente ajusta ao último do mês");
    assert.strictEqual(somarMesesCom("2026-10-31", 1), "2026-11-30");
    assert.strictEqual(somarMesesCom("2026-12-15", 1), "2027-01-15");
    assert.strictEqual(somarMesesCom("2026-01-15", -1), "2025-12-15");

    const inicioDaSemana = new Function(
        "dataISO", "somarDias", extractBody(js, "inicioDaSemana(dataISO)")
    );
    const inicioSemana = (data) => inicioDaSemana(data, somarDias);
    assert.strictEqual(inicioSemana("2026-10-20"), "2026-10-18", "domingo da semana");
    const fimDaSemana = new Function(
        "dataISO", "somarDias", "inicioDaSemana",
        extractBody(js, "fimDaSemana(dataISO)")
    );
    const fimSemana = (data) => fimDaSemana(data, somarDias, inicioSemana);
    assert.strictEqual(fimSemana("2026-10-20"), "2026-10-24",
        "sábado da semana visual");

    const FALLBACK = "pt-BR";
    const rotuloMes = new Function(
        "ano", "mes", "idioma", "capitalizar", "IDIOMA_FALLBACK",
        extractBody(js, "rotuloMes(ano, mes, idioma)")
    );
    assert.strictEqual(rotuloMes(2026, 10, "pt-BR", capitalizar, FALLBACK), "Outubro de 2026");
    assert.strictEqual(rotuloMes(2026, 10, "en-US", capitalizar, FALLBACK), "October 2026");
    assert.strictEqual(rotuloMes(2026, 10, undefined, capitalizar, FALLBACK), "Outubro de 2026",
        "fallback pt-BR quando o idioma não vem");

    const rotulosSemana = new Function(
        "idioma", "capitalizar", "IDIOMA_FALLBACK",
        extractBody(js, "rotulosSemana(idioma)")
    );
    assert.deepStrictEqual(
        rotulosSemana("pt-BR", capitalizar, FALLBACK),
        ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]
    );
    assert.deepStrictEqual(
        rotulosSemana("en-US", capitalizar, FALLBACK).slice(0, 3),
        ["Sun", "Mon", "Tue"]
    );

    const nomeCompletoData = new Function(
        "dataISO", "idioma", "IDIOMA_FALLBACK",
        extractBody(js, "nomeCompletoData(dataISO, idioma)")
    );
    assert.strictEqual(
        nomeCompletoData("2026-10-08", "pt-BR", FALLBACK), "8 de outubro de 2026"
    );
    assert.strictEqual(
        nomeCompletoData("2026-10-08", "en-US", FALLBACK), "October 8, 2026"
    );

    const rotuloRemoverDia = new Function(
        "dataISO", "idioma", "prefixo", "nomeCompletoData",
        extractBody(js, "rotuloRemoverDia(dataISO, idioma, prefixo)")
    );
    assert.strictEqual(
        rotuloRemoverDia("2026-10-08", "pt-BR", "Remover", nomeCompletoData),
        "Remover 8 de outubro de 2026"
    );

    // "Hoje" é um estado próprio da célula, sem marcar a data automaticamente.
    const celulasDoMes = new Function(
        "ano", "mes", "diasMarcados", "hojeISO", "duasCasas",
        extractBody(js, "celulasDoMes(ano, mes, diasMarcados, hojeISO)")
    );
    const outubro = celulasDoMes(2026, 10, [], "2026-10-20", duasCasas);
    assert.strictEqual(outubro.find((c) => c && c.data === "2026-10-20").hoje, true);
    assert.strictEqual(outubro.find((c) => c && c.data === "2026-10-21").hoje, false);

    // Teclado: setas, Home/End, Page Up/Down e Espaço/Enter.
    const handler = new Function(
        "somarDias", "somarMeses", "inicioDaSemana", "fimDaSemana", "ev",
        extractBody(js, "onCalendarioKeydown(ev)")
    );
    const contextoTeclado = () => ({
        calendarioHabilitado: true,
        focoVisivel: "2026-10-20",
        movido: null,
        alternou: 0,
        moverFoco(data) {
            this.movido = data;
        },
        alternarDiaFocado() {
            this.alternou++;
        },
    });
    const tecla = (key, contexto) => {
        const evento = {
            key,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };
        handler.call(
            contexto, somarDias, somarMesesCom, inicioSemana, fimSemana, evento
        );
        return evento;
    };
    let contexto = contextoTeclado();
    assert.strictEqual(tecla("ArrowRight", contexto).defaultPrevented, true);
    assert.strictEqual(contexto.movido, "2026-10-21", "→ anda um dia");
    contexto = contextoTeclado();
    tecla("ArrowLeft", contexto);
    assert.strictEqual(contexto.movido, "2026-10-19", "← anda um dia");
    contexto = contextoTeclado();
    tecla("ArrowUp", contexto);
    assert.strictEqual(contexto.movido, "2026-10-13", "↑ anda uma semana");
    contexto = contextoTeclado();
    tecla("ArrowDown", contexto);
    assert.strictEqual(contexto.movido, "2026-10-27", "↓ anda uma semana");
    contexto = contextoTeclado();
    tecla("Home", contexto);
    assert.strictEqual(contexto.movido, "2026-10-18", "Home = início da semana visual");
    contexto = contextoTeclado();
    tecla("End", contexto);
    assert.strictEqual(contexto.movido, "2026-10-24", "End = fim da semana visual");
    contexto = contextoTeclado();
    tecla("PageUp", contexto);
    assert.strictEqual(contexto.movido, "2026-09-20", "Page Up = mês anterior");
    contexto = contextoTeclado();
    tecla("PageDown", contexto);
    assert.strictEqual(contexto.movido, "2026-11-20", "Page Down = próximo mês");
    for (const key of [" ", "Enter"]) {
        contexto = contextoTeclado();
        const evento = tecla(key, contexto);
        assert.strictEqual(contexto.alternou, 1, `${key} marca/desmarca o dia focado`);
        assert.strictEqual(contexto.movido, null, `${key} não move o foco`);
        assert.strictEqual(evento.defaultPrevented, true);
    }
    contexto = contextoTeclado();
    const naoTratada = tecla("a", contexto);
    assert.strictEqual(contexto.movido, null, "tecla comum não move o foco");
    assert.strictEqual(naoTratada.defaultPrevented, false, "tecla comum não é bloqueada");
    contexto = contextoTeclado();
    contexto.calendarioHabilitado = false;
    tecla("ArrowRight", contexto);
    assert.strictEqual(contexto.movido, null, "calendário desabilitado ignora o teclado");

    // Mover foco muda mês e prepara o foco do DOM; não altera a seleção.
    const moverFoco = new Function("data", extractBody(js, "moverFoco(data)"));
    const componente = {
        state: { focoData: "2026-10-20", mesVisivel: { ano: 2026, mes: 10 } },
        _focoPendente: null,
    };
    moverFoco.call(componente, "2026-11-05");
    assert.strictEqual(componente.state.focoData, "2026-11-05");
    assert.deepStrictEqual(componente.state.mesVisivel, { ano: 2026, mes: 11 });
    assert(componente._focoPendente.includes('data-data="2026-11-05"'),
        "foco do DOM pendente na célula de destino");

    const alternarDiaFocado = new Function(extractBody(js, "alternarDiaFocado()"));
    const focado = {
        focoVisivel: "2026-10-20",
        alternado: null,
        toggleDia(data) {
            this.alternado = data;
        },
    };
    alternarDiaFocado.call(focado);
    assert.strictEqual(focado.alternado, "2026-10-20", "Enter/Espaço alternam o dia focado");

    // Remover chip: foco vai para o próximo chip ou para a grade quando acaba.
    const removerDia = new Function("data", extractBody(js, "removerDia(data)"));
    const comChips = {
        state: { dias: ["2026-10-08", "2026-10-09", "2026-10-10"] },
        focoVisivel: "2026-10-08",
        toggleDia(data) {
            this.state.dias = this.state.dias.filter((dia) => dia !== data);
        },
        _focoPendente: null,
    };
    removerDia.call(comChips, "2026-10-08");
    assert.strictEqual(comChips._focoPendente, '.o_consulta_chip_remover[data-indice="0"]',
        "foco no próximo chip");
    const ultimoChip = {
        state: { dias: ["2026-10-08"] },
        focoVisivel: "2026-10-08",
        toggleDia(data) {
            this.state.dias = this.state.dias.filter((dia) => dia !== data);
        },
        _focoPendente: null,
    };
    removerDia.call(ultimoChip, "2026-10-08");
    assert(ultimoChip._focoPendente.includes("o_consulta_dia"), "sem chips, foco na grade");

    // Chips recolhidos: poucos visíveis + "Ver os N dias"; data curta com ano
    // só quando a seleção atravessa anos.
    const diasVisiveis = new Function(
        "CHIPS_VISIVEIS", extractBody(js, "get diasVisiveis()")
    );
    const trintaEUm = Array.from(
        { length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`
    );
    assert.strictEqual(
        diasVisiveis.call({ state: { mostrarTodosChips: false, dias: trintaEUm } }, 6).length,
        6, "seleção longa começa recolhida"
    );
    assert.strictEqual(
        diasVisiveis.call({ state: { mostrarTodosChips: true, dias: trintaEUm } }, 6).length,
        31, "expansão acessa todos os dias"
    );
    const rotuloVerChips = new Function(
        "_t", extractBody(js, "get rotuloVerChips()")
    );
    assert.strictEqual(
        rotuloVerChips.call({ state: { mostrarTodosChips: false, dias: trintaEUm } }, traduzir18),
        "Ver os 31 dias"
    );
    assert.strictEqual(
        rotuloVerChips.call({ state: { mostrarTodosChips: true, dias: trintaEUm } }, traduzir18),
        "Mostrar menos"
    );
    const formatarDataCurta = new Function(
        "data", extractBody(js, "formatarDataCurta(data)")
    );
    assert.strictEqual(
        formatarDataCurta.call({ anosDistintos: false }, "2026-10-08"), "08/10"
    );
    assert.strictEqual(
        formatarDataCurta.call({ anosDistintos: true }, "2026-10-08"), "08/10/2026"
    );

    console.log("✓ 18: calendário acessível, teclado e idioma do Odoo");
}

console.log("\nTodos os contratos da tela de consulta passaram.");
