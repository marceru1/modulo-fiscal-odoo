/**
 * Contrato textual (Node puro) do patch de sangria/suprimento offline
 * (cash_move_popup_patch.js — ticket 03), no padrão de test_fechamento_lock.js.
 *
 * Garante que:
 *   - o patch importa a outbox e o gancho de refresh do snapshot;
 *   - `out` e `in` passam pelo MESMO caminho offline (checagem antes do
 *     despacho nativo);
 *   - o caminho offline não chama o data_service (nada cai na fila em memória);
 *   - a sangria online usa queue=false (para capturar ConnectionLostError);
 *   - o movimento online alimenta o espelho e pede refresh do snapshot;
 *   - o recibo da sangria continua saindo (renderToElement + printFallback);
 *   - a outbox está no manifest ANTES do patch que a importa.
 *
 * Rodar: node meu_modulo_fiscal/tests/test_sangria_offline.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const MODULE_ROOT = path.join(__dirname, "..");
const PATCH_PATH = path.join(MODULE_ROOT, "static", "src", "js", "cash_move_popup_patch.js");
const MANIFEST_PATH = path.join(MODULE_ROOT, "__manifest__.py");

const source = fs.readFileSync(PATCH_PATH, "utf8");

// ── 1. Importa a outbox + gancho de refresh ───────────────────────────────
assert.match(
    source,
    /import\s*\{[^}]*createOutbox[^}]*\}\s*from\s*["']\.\/fechamento_outbox["']/,
    "O patch deve importar createOutbox de ./fechamento_outbox"
);
assert.match(
    source,
    /import\s*\{[^}]*solicitarRefreshSnapshot[^}]*\}\s*from\s*["']\.\/fechamento_outbox["']/,
    "O patch deve importar solicitarRefreshSnapshot"
);
console.log("✓ 1: patch importa a outbox e o gancho de refresh");

// ── 2. Checagem offline antes do despacho nativo (cobre out E in) ─────────
const idxOffline = source.indexOf("this.pos.data.network.offline");
const idxInNativo = source.indexOf('if (type !== "out")');
assert.ok(idxOffline !== -1, "confirm() deve checar network.offline");
assert.ok(idxInNativo !== -1, "confirm() deve delegar 'in' ao caminho nativo");
assert.ok(
    idxOffline < idxInNativo,
    "A checagem offline deve vir ANTES da delegação do 'in' (senão o suprimento não passa pela outbox)"
);
assert.match(
    source.slice(idxOffline, idxOffline + 220),
    /_confirmarMovimentoOffline\(/,
    "Offline deve desviar para _confirmarMovimentoOffline"
);
console.log("✓ 2: off-line passa pela outbox antes do caminho nativo (out e in)");

// ── 3. O caminho offline não chama o data_service ─────────────────────────
const inicioOffline = source.indexOf(
    "_confirmarMovimentoOffline(type, amount, reason, formattedAmount) {"
);
const fimOffline = source.indexOf("_espelharMovimentoOnline(type, amount, reason) {");
assert.ok(inicioOffline !== -1 && fimOffline > inicioOffline, "Método _confirmarMovimentoOffline deve existir");
const corpoOffline = source.slice(inicioOffline, fimOffline);
assert.match(corpoOffline, /\.adicionar\(/, "Offline deve gravar na outbox (.adicionar)");
assert.ok(
    !/data\.call\(/.test(corpoOffline),
    "Offline NÃO pode chamar data.call (nada cai na fila em memória do core)"
);
console.log("✓ 3: caminho offline não usa a fila genérica do data_service");

// ── 4. Sangria online com queue=false e espelho ───────────────────────────
assert.match(
    source,
    /try_cash_in_out[\s\S]{0,600}\{\}\s*,\s*false\s*\)/,
    "try_cash_in_out da sangria deve usar queue=false"
);
assert.ok(
    !/try_cash_in_out[\s\S]{0,600}\{\}\s*,\s*true\s*\)/.test(source),
    "Nenhum try_cash_in_out pode usar queue=true (fila em memória)"
);
assert.match(
    source,
    /_espelharMovimentoOnline\(/,
    "Movimento online deve alimentar o espelho"
);
assert.match(
    source,
    /espelharOnline\(/,
    "Espelho online deve usar espelharOnline"
);
assert.match(
    source,
    /solicitarRefreshSnapshot\(\)/,
    "Online confirmado deve pedir refresh do snapshot"
);
console.log("✓ 4: sangria online sem fila em memória + espelho + refresh");

// ── 5. Recibo da sangria continua saindo ──────────────────────────────────
assert.match(source, /renderToElement\(\s*["']meu_modulo_fiscal\.SangriaReceipt["']/);
assert.match(source, /hardwareProxy\.printer/);
assert.match(source, /printFallback\(/);
console.log("✓ 5: recibo da sangria mantém renderToElement + printFallback");

// ── 6. Erro de rede cai na outbox; erro de negócio propaga ────────────────
assert.match(
    source,
    /if\s*\(!this\._ehErroDeRede\(error\)\)/,
    "O caminho online deve separar erro de rede de erro de negócio"
);
console.log("✓ 6: queda de rede no meio da sangria cai na outbox");

// ── 7. Manifest: outbox antes do patch ────────────────────────────────────
const manifest = fs.readFileSync(MANIFEST_PATH, "utf8");
const idxOutbox = manifest.indexOf(
    "meu_modulo_fiscal/static/src/js/fechamento_outbox.js"
);
const idxPatch = manifest.indexOf(
    "meu_modulo_fiscal/static/src/js/cash_move_popup_patch.js"
);
assert.ok(idxOutbox !== -1, "fechamento_outbox.js deve estar no manifest");
assert.ok(idxPatch !== -1, "cash_move_popup_patch.js deve estar no manifest");
assert.ok(idxOutbox < idxPatch, "fechamento_outbox.js deve vir ANTES do patch que o importa");
console.log("✓ 7: manifest carrega a outbox antes do patch");

console.log("\nTodos os testes passaram ✓");
