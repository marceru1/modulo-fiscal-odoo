-- =========================================================================
-- pre_deploy_prazo_check.sql
-- Checagem SOMENTE LEITURA para rodar ANTES do deploy da feature
-- "Conta a prazo no contato" (spec prazo-por-contato, DEC-I).
--
-- Como rodar (Postgres do Odoo, no servidor):
--   psql -v company_id=<id_da_empresa> -d <banco_odoo> \
--        -f meu_modulo_fiscal/scripts/pre_deploy_prazo_check.sql
--
-- O parâmetro company_id é o id da empresa usada no PDV (res_company.id);
-- ele indexa o jsonb do campo company_dependent credit_limit (ex.: {"1": 200}).
--
-- Só há SELECT: nada é alterado e nada roda automaticamente. Revise os três
-- blocos e aplique a ação indicada em cada comentário ANTES do upgrade.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1) Funcionários ATIVOS com usuário vinculado e SEM contato de trabalho.
--    A conta a prazo passa a viver no CONTATO (DEC-A/DEC-I): sem
--    work_contact_id o limite some da ficha do funcionário.
--    AÇÃO: preencher o Contato de Trabalho (ou o limite no contato do
--    usuário) antes do deploy. Lista vazia = nada a fazer.
-- -------------------------------------------------------------------------
SELECT e.id             AS employee_id,
       e.name           AS funcionario,
       u.id             AS user_id,
       u.login          AS usuario,
       u.partner_id     AS partner_do_usuario
FROM hr_employee e
JOIN res_users u ON u.id = e.user_id
WHERE e.active IS TRUE
  AND e.work_contact_id IS NULL
ORDER BY e.name;


-- -------------------------------------------------------------------------
-- 2) Contatos que JÁ compraram a prazo e estão com limite <= 0 na empresa.
--    Com DEC-C (sem_limite vira bloqueio no PDV) eles PASSAM A SER
--    BLOQUEADOS na venda a prazo.
--    AÇÃO: cadastrar Credit Limit na aba Faturamento do contato antes do
--    deploy, ou confirmar conscientemente que o bloqueio é desejado.
--    credit_limit é company_dependent (jsonb; chave = id da empresa em
--    texto), então NÃO existe coluna numérica para somar.
-- -------------------------------------------------------------------------
SELECT p.id            AS partner_id,
       p.name          AS contato,
       COALESCE((p.credit_limit ->> :'company_id')::numeric, 0) AS limite_empresa,
       COUNT(m.id)     AS compras_a_prazo
FROM res_partner p
JOIN x_prazo_movimentacao m
  ON m.partner_id = p.id
 AND m.tipo = 'compra'
WHERE COALESCE((p.credit_limit ->> :'company_id')::numeric, 0) <= 0
GROUP BY p.id, p.name, p.credit_limit
ORDER BY compras_a_prazo DESC, p.name;


-- -------------------------------------------------------------------------
-- 3) Estado da coluna employee_id em x_prazo_movimentacao ANTES do upgrade.
--    O upgrade dropa a coluna (o modelo não a declara mais) e leva junto
--    NOT NULL/default/FK dela. Resultado vazio na primeira consulta =
--    coluna já não existe; não há nada a fazer.
--    AÇÃO: se a coluna existir e a segunda consulta listar uma FK, o DROP
--    feito pelo Odoo é seguro (a constraint sai com a coluna); apenas
--    registre o estado para o rollback. Nada precisa ser alterado à mão.
-- -------------------------------------------------------------------------
SELECT column_name,
       data_type,
       is_nullable,
       column_default
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'x_prazo_movimentacao'
  AND column_name = 'employee_id';

SELECT conname                     AS constraint_name,
       contype                     AS tipo,
       pg_get_constraintdef(oid)   AS definicao
FROM pg_constraint
WHERE conrelid = to_regclass('x_prazo_movimentacao')
  AND pg_get_constraintdef(oid) ILIKE '%employee_id%';
