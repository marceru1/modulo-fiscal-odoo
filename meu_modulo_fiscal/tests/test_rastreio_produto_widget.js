/**
 * Teste unitário (Node puro, sem Odoo) do widget de confirmação ao desmarcar
 * "Rastrear inventário" (ticket 02 da feature rastreio-produto).
 *
 * Dois blocos, no padrão dos testes Node do módulo (extração do fonte real,
 * mesmo padrão de tests/test_preco_badge_produto.js):
 *
 *   1. Decisão pura `deveConfirmarDesmarcarRastreio` — só pergunta em
 *      marcado → desmarcado; religar e no-op nunca perguntam (DEC-002).
 *   2. Contrato de arquivos:
 *      - manifest registra JS+XML no bundle `web.assets_backend`, JS antes do XML;
 *      - view herda product.product_template_form_view, mira
 *        //field[@name='is_storable'] com position="attributes" e só troca
 *        o widget (invisible nativo preservado; nada de position="replace");
 *      - widget estende o boolean nativo e usa ConfirmationDialog;
 *      - copy do DEC-004 exatamente como aprovada, sem a frase
 *        "movimentos ... deixam de ser gerados" (core: stock_move.py:1778
 *        continua criando movimentos; só o saldo para de atualizar);
 *      - cancelar restaura o visual remontando o CheckBox (t-key), porque o
 *        toggle nativo altera o DOM antes do handler.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_rastreio_produto_widget.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const SRC = path.join(MODULE_ROOT, "static", "src");
const read = (p) => fs.readFileSync(p, "utf8");

const jsSource = read(path.join(SRC, "js", "rastreio_produto.js"));
const templateSource = read(path.join(SRC, "xml", "rastreio_produto.xml"));
const viewSource = read(path.join(MODULE_ROOT, "views", "rastreio_produto_views.xml"));
const manifest = read(path.join(MODULE_ROOT, "__manifest__.py"));

// ── Extração da função pura (balanceamento de chaves) ────────────────────────
function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert(start !== -1, `Não encontrou function ${name}()`);
    const braceIdx = src.indexOf("{", start);
    let depth = 0;
    for (let i = braceIdx; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
            depth--;
            if (depth === 0) {
                const fnSrc = src.slice(start, i + 1);
                return new Function(`${fnSrc}; return ${name};`)();
            }
        }
    }
    throw new Error(`Corpo da função ${name}() desbalanceado`);
}

const deveConfirmar = extractFunction(jsSource, "deveConfirmarDesmarcarRastreio");

// ── Caso 1: decisão pura do widget ──────────────────────────────────────────
{
    assert.strictEqual(
        deveConfirmar(true, false),
        true,
        "Marcado → desmarcado DEVE perguntar"
    );
    assert.strictEqual(deveConfirmar(false, true), false, "Religar não pergunta");
    assert.strictEqual(deveConfirmar(true, true), false, "No-op marcado não pergunta");
    assert.strictEqual(deveConfirmar(false, false), false, "No-op desmarcado não pergunta");
    assert.strictEqual(
        deveConfirmar(undefined, false),
        false,
        "Valor inicial ausente não pode disparar confirmação (strict === true)"
    );
    assert.strictEqual(deveConfirmar(1, false), false, "Só booleano true dispara (sem coerção)");
    console.log("✓ Caso 1: decisão pura — só True→False pergunta; religar/no-op não");
}

// ── Caso 2: widget estende o boolean nativo e usa o diálogo nativo ──────────
{
    assert(
        /import \{[^}]*BooleanField[^}]*\} from "@web\/views\/fields\/boolean\/boolean_field"/.test(jsSource),
        "O widget deve estender o BooleanField nativo do backend"
    );
    assert(
        /extends BooleanField/.test(jsSource),
        "A classe do widget deve herdar de BooleanField"
    );
    assert(
        /import \{ ConfirmationDialog \} from "@web\/core\/confirmation_dialog\/confirmation_dialog"/.test(
            jsSource
        ),
        "Deve usar o ConfirmationDialog nativo do web client (DEC-002)"
    );
    assert(
        /services\.dialog\.add\(ConfirmationDialog/.test(jsSource),
        "Deve abrir o diálogo pelo serviço de dialog do web client"
    );
    assert(
        /registry\.category\("fields"\)\.add\(\s*"desmarcar_rastreio_confirmacao"/.test(jsSource),
        "Widget deve ser registrado no registry de fields com o nome usado na view"
    );
    assert(
        /static template = "meu_modulo_fiscal\.DesmarcarRastreioBooleanField"/.test(jsSource),
        "O template do widget deve ser o do módulo"
    );
    assert(
        /confirm:\s*\(\)\s*=>\s*super\.onChange\(newValue\)/.test(jsSource),
        "Confirmar deve aplicar o valor pelo fluxo normal do boolean (sem save automático)"
    );
    console.log("✓ Caso 2: estende BooleanField, ConfirmationDialog nativo, registry fields");
}

// ── Caso 3: copy do DEC-004 exatamente aprovada ─────────────────────────────
{
    const TITULO = "Desativar rastreio de estoque?";
    const CORPO =
        'Ao desmarcar "Rastrear inventário", o Odoo deixa de controlar a quantidade em estoque deste produto: o saldo (On Hand) deixa de ser atualizado. Você pode marcar de novo depois, mas o que for vendido ou movimentado enquanto estiver desligado não entra no saldo. Deseja continuar?';

    assert(jsSource.includes(TITULO), `Título aprovado ausente: ${TITULO}`);
    assert(jsSource.includes(CORPO), "Corpo do modal difere do texto aprovado na spec (DEC-004)");
    assert(jsSource.includes('"Desativar rastreio"'), 'Botão de confirmação deve ser "Desativar rastreio"');
    assert(jsSource.includes('"Cancelar"'), 'Botão de cancelamento deve ser "Cancelar"');
    assert(
        !/movimentos?\s+deixam?\s+de\s+ser\s+gerad/i.test(jsSource),
        'A copy NÃO pode afirmar que "movimentos deixam de ser gerados" (stock_move.py:1778: ' +
            "o movimento continua sendo criado; só o saldo para de atualizar)"
    );
    assert(
        jsSource.includes("saldo (On Hand) deixa de ser atualizado"),
        "A copy deve afirmar apenas a consequência verdadeira (saldo não atualiza)"
    );
    console.log("✓ Caso 3: copy do DEC-004 exata, sem a frase de movimentos");
}

// ── Caso 4: cancelar restaura o estado visual (remonta o CheckBox) ──────────
{
    assert(
        /cancel:\s*\(\)\s*=>\s*\{[\s\S]*?desmarcarRastreioRemontar\s*\+=\s*1/.test(jsSource),
        "Cancelar deve forçar a remontagem do CheckBox (o toggle nativo já alterou o DOM)"
    );
    assert(
        /t-key="state\.desmarcarRastreioRemontar"/.test(templateSource),
        "O template deve usar o contador como t-key do CheckBox"
    );
    assert(
        /t-name="meu_modulo_fiscal\.DesmarcarRastreioBooleanField"/.test(templateSource),
        "O template deve registrar o t-name usado pelo widget"
    );
    assert(
        /<CheckBox[\s\S]*value="state\.value"[\s\S]*onChange\.bind="onChange"/.test(templateSource),
        "O template deve ligar o CheckBox ao estado e ao handler onChange do widget"
    );
    console.log("✓ Caso 4: cancelar remonta o CheckBox (restaura o DOM do toggle nativo)");
}

// ── Caso 5: view — herança aditiva, xpath único, sem replace ────────────────
{
    // Comentários XML podem citar a proibição; o contrato vale para o XML real.
    const viewSemComentarios = viewSource.replace(/<!--[\s\S]*?-->/g, "");
    assert(
        /inherit_id" ref="product\.product_template_form_view"/.test(viewSource),
        "A herança deve ser de product.product_template_form_view (DEC-003)"
    );
    assert(
        /xpath expr="\/\/field\[@name='is_storable'\]" position="attributes"/.test(viewSource),
        "O xpath deve mirar //field[@name='is_storable'] com position=attributes"
    );
    assert(
        /<attribute name="widget">desmarcar_rastreio_confirmacao<\/attribute>/.test(viewSource),
        "A herança deve trocar SÓ o widget do campo"
    );
    assert(
        !/position="replace"/.test(viewSemComentarios),
        'position="replace" é proibido (pode quebrar o DOM/outros módulos)'
    );
    assert(
        !/attribute name="invisible"/.test(viewSemComentarios),
        'A herança não pode tocar o invisible nativo (type != "consu" vem do core)'
    );
    console.log("✓ Caso 5: view herda o form nativo, mira is_storable e só troca o widget");
}

// ── Caso 6: manifest — JS+XML no bundle de backend, JS antes do XML ─────────
{
    const jsAsset = "meu_modulo_fiscal/static/src/js/rastreio_produto.js";
    const xmlAsset = "meu_modulo_fiscal/static/src/xml/rastreio_produto.xml";
    const backendIdx = manifest.indexOf("'web.assets_backend': [");
    assert(backendIdx !== -1, "Manifest deve declarar o bundle web.assets_backend");

    const backendBlock = manifest.slice(backendIdx, manifest.indexOf("],", backendIdx));
    assert(backendBlock.includes(jsAsset), `Bundle web.assets_backend sem ${jsAsset}`);
    assert(backendBlock.includes(xmlAsset), `Bundle web.assets_backend sem ${xmlAsset}`);
    assert(
        backendBlock.indexOf(jsAsset) < backendBlock.indexOf(xmlAsset),
        "JS antes do XML: o template usa a classe/handler do JS"
    );
    console.log("✓ Caso 6: JS+XML no web.assets_backend, JS antes do XML");
}

console.log("\nTodos os testes passaram ✓");
