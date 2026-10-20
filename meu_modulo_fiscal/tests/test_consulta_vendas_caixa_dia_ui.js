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
 *   - estados: data desabilitada sem caixa, Consultar bloqueado, loading sem
 *     consulta dupla, erro != vazio, resultado velho limpo ao trocar filtros
 *   - detalhe da venda abre read-only (create/edit/delete: false)
 *   - manifest: tela no web.assets_backend, NUNCA no bundle do POS
 *   - comportamento dos helpers puros (podeConsultar/formatarData/mensagemErro)
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
        /orm\.call\(\s*"pos\.order",\s*"get_vendas_caixa_dia",\s*\[this\.state\.configId,\s*this\.state\.data\]/.test(js),
        "deve chamar pos.order.get_vendas_caixa_dia com caixa e data"
    );
    console.log("✓ 5: chama o método server-side do ticket 01");
}

// ── 6: estados da tela ─────────────────────────────────────────────────────
{
    // Abertura: orientação e nenhuma consulta automática.
    assert(
        (js + xml).includes("Selecione um caixa e uma data para consultar as vendas"),
        "mensagem inicial"
    );
    assert(!/onWillStart\([^)]*consultar/.test(js), "não consultar ao abrir");

    // Caixa selecionado habilita a data.
    assert(/t-att-disabled="!state\.configId \|\| state\.carregando"/.test(xml), "data desabilitada sem caixa");

    // Consultar habilita só com caixa + data e nunca durante loading.
    assert(/get podeConsultar\(\)/.test(js), "getter podeConsultar");
    assert(/!\s*this\.state\.carregando/.test(extractBody(js, "get podeConsultar()")), "loading impede consulta");

    // Loading visível.
    assert(xml.includes("Consultando..."), "indicador de carregamento");

    // Erro != vazio.
    assert(/state\.erro = this\.mensagemErro\(error\)/.test(js), "erro tratado à parte");
    assert(xml.includes("Nenhuma venda encontrada para este caixa nesta data"), "mensagem de dia vazio");

    // Trocar filtro limpa o resultado velho.
    const limpar = extractBody(js, "alterouFiltros()");
    assert(/this\.state\.resultado = null/.test(limpar), "trocar filtro limpa resultado");
    assert(/onConfigChange[\s\S]*alterouFiltros/.test(js), "mudar caixa limpa resultado");
    assert(/onDataChange[\s\S]*alterouFiltros/.test(js), "mudar data limpa resultado");
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
    assert.strictEqual(podeConsultar({ configId: false, data: "", carregando: false }), false);
    assert.strictEqual(podeConsultar({ configId: 1, data: "", carregando: false }), false);
    assert.strictEqual(podeConsultar({ configId: false, data: "2026-10-20", carregando: false }), false);
    assert.strictEqual(podeConsultar({ configId: 1, data: "2026-10-20", carregando: true }), false);
    assert.strictEqual(podeConsultar({ configId: 1, data: "2026-10-20", carregando: false }), true);

    const formatarData = new Function("data", extractBody(js, "formatarData(data)"));
    assert.strictEqual(formatarData("2026-10-20"), "20/10/2026");
    assert.strictEqual(formatarData(""), "");

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

console.log("\nTodos os contratos da tela de consulta passaram.");
