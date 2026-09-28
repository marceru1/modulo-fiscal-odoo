/**
 * Teste unitário (Node puro, sem Odoo) do ticket 03 da feature
 * filtro-pedidos-pagos-pos: template XML dos chips + registro no __manifest__.
 *
 * O Odoo não roda localmente, então este teste valida o CONTRATO do arquivo:
 *   - XML bem-formado (scanner de balanceamento de tags, sem dependência)
 *   - herança de point_of_sale.TicketScreen no padrão do repo
 *   - xpath com position="after" (nunca "replace")
 *   - chips só no tab pago (state.filter === 'SYNCED')
 *   - chips gerados de getAvailablePaymentMethods() com t-key estável
 *   - clique chama onTogglePaymentChip(method.id)
 *   - t-esc (XSS-safe) e não t-raw
 *   - classes: nenhuma mistura de class estatico com t-att-class (o motor
 *     Python do QWeb SOBRESCREVE o class estatico nesse caso — por isso o
 *     arquivo usa t-attf-class com a string completa)
 *   - manifest: JS e XML registrados em point_of_sale._assets_pos, JS antes
 *
 * Rodar: node meu_modulo_fiscal/tests/test_filtro_pedidos_assets.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const XML_PATH = path.join(MODULE_ROOT, "static", "src", "xml", "filtro_pedidos.xml");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const xml = fs.readFileSync(XML_PATH, "utf8");
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");

// ── XML bem-formado: scanner de balanceamento de tags ─────────────────────
// Ignora comentários e trata tags auto-fechadas. Não é um parser completo,
// mas pega o erro real que importa aqui: tag aberta sem fechar.
function assertBalancedTags(source) {
    const noComments = source.replace(/<!--[\s\S]*?-->/g, "");
    const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>/g;
    const stack = [];
    let m;
    while ((m = tagRe.exec(noComments))) {
        const [, closing, name, , selfClosing] = m;
        if (name.startsWith("?") || name.startsWith("!")) {
            continue; // declaração <?xml ...?>
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

// ── 1: XML bem-formado ────────────────────────────────────────────────────
{
    assert(xml.startsWith("<?xml version="), "deve começar com declaração XML");
    assertBalancedTags(xml);
    console.log("✓ 1: XML bem-formado");
}

// ── 2: herança no padrão do repo ──────────────────────────────────────────
{
    assert(
        /<t\s+t-name="[^"]+"\s+t-inherit="point_of_sale\.TicketScreen"\s+t-inherit-mode="extension"/.test(xml),
        "deve herdar point_of_sale.TicketScreen com t-inherit-mode='extension'"
    );
    console.log("✓ 2: herda point_of_sale.TicketScreen");
}

// ── 3: xpath com position="after", nunca "replace" ────────────────────────
{
    assert(/<xpath [^>]*position="after"/.test(xml), "deve usar position='after'");
    assert(!/position="replace"/.test(xml), "não pode usar position='replace' (quebra o DOM)");
    console.log("✓ 3: position='after', sem replace");
}

// ── 4: ancoragem em .controls (desvio documentado do ticket 03) ───────────
// O ticket pedia ancorar no <SearchBar>, mas o <SearchBar> vive dentro de
// .controls, que é grid nomeado no mobile e flex SEM wrap no desktop
// (ticket_screen.scss:58-63). Ancorar ali jogaria os chips na mesma linha
// dos controles no desktop, contra o DEC-007 ("linha abaixo da SearchBar").
{
    assert(
        /<xpath expr="\/\/div\[hasclass\('controls'\)\]" position="after"/.test(xml),
        "deve ancorar depois de .controls"
    );
    console.log("✓ 4: ancorado após .controls (linha própria em todo breakpoint)");
}

// ── 5: visível só no tab "Pago" ───────────────────────────────────────────
{
    assert(/t-if="state\.filter === 'SYNCED'"/.test(xml), "chips só quando filter === 'SYNCED'");
    console.log("✓ 5: chips só no tab Pago (SYNCED)");
}

// ── 6: chips gerados dos métodos da sessão, com chave estável ─────────────
{
    assert(
        /t-foreach="getAvailablePaymentMethods\(\)" t-as="method" t-key="method\.id"/.test(xml),
        "deve iterar getAvailablePaymentMethods() com t-key='method.id'"
    );
    console.log("✓ 6: t-foreach sobre getAvailablePaymentMethods()");
}

// ── 7: clique alterna o chip ──────────────────────────────────────────────
{
    assert(
        /t-on-click="\(\) =&gt; this\.onTogglePaymentChip\(method\.id\)"/.test(xml),
        "t-on-click deve chamar onTogglePaymentChip(method.id)"
    );
    console.log("✓ 7: clique chama onTogglePaymentChip(method.id)");
}

// ── 8: t-esc para user data, nunca t-raw ──────────────────────────────────
{
    assert(/<t t-esc="method\.name"\/>/.test(xml), "nome do método deve sair via t-esc");
    assert(!/t-raw/.test(xml), "t-raw é XSS-unsafe, não usar");
    console.log("✓ 8: t-esc (sem t-raw)");
}

// ── 9: classes só via t-attf-class / t-att-* (nunca class + t-att-class) ──
// Fonte: ir_qweb.py addAttributes() — o class estático é atribuído primeiro e
// o t-att-class SOBRESCREVE a chave 'class' do dict de attrs (sem merge).
{
    const tagsWithStaticClass = [];
    const tagRe = /<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
    let m;
    while ((m = tagRe.exec(xml))) {
        const attrs = m[2];
        const hasStaticClass = /(^|\s)class="/.test(attrs);
        const hasDynamicClass = /t-att-?f?-class=/.test(attrs);
        if (hasStaticClass && hasDynamicClass) {
            tagsWithStaticClass.push(m[1]);
        }
    }
    assert.deepStrictEqual(
        tagsWithStaticClass,
        [],
        `estes tags misturam class estático com t-att-class (perde o estático): ${tagsWithStaticClass}`
    );
    assert(/t-attf-class=/.test(xml), "deve usar t-attf-class para a class dos chips");
    console.log("✓ 9: classes sem o gotcha class + t-att-class");
}

// ── 10: scroll horizontal no mobile ───────────────────────────────────────
{
    assert(/ui\.isSmall/.test(xml), "deve tratar ui.isSmall (scroll horizontal no mobile)");
    assert(/flex-nowrap/.test(xml) && /flex-wrap/.test(xml), "flex-nowrap no mobile / flex-wrap no desktop");
    console.log("✓ 10: scroll horizontal no mobile");
}

// ── 11: manifest registra JS antes do XML em point_of_sale._assets_pos ────
{
    const start = manifest.indexOf("'point_of_sale._assets_pos'");
    const end = manifest.indexOf("'web.assets_web'");
    assert(start !== -1 && end > start, "não achou o bloco point_of_sale._assets_pos");

    const block = manifest.slice(start, end);
    const jsIdx = block.indexOf("static/src/js/filtro_pedidos.js");
    const xmlIdx = block.indexOf("static/src/xml/filtro_pedidos.xml");

    assert(jsIdx !== -1, "filtro_pedidos.js deve estar em point_of_sale._assets_pos");
    assert(xmlIdx !== -1, "filtro_pedidos.xml deve estar em point_of_sale._assets_pos");
    assert(jsIdx < xmlIdx, "o JS deve ser registrado ANTES do XML (template depende do patch)");
    console.log("✓ 11: manifest registra JS antes do XML em _assets_pos");
}

console.log("\nTodos os testes passaram ✓");
