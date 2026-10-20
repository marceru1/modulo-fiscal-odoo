from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase

TZ = "America/Manaus"


class TestConsultaVendasCaixaDia(TransactionCase):
    """Contrato do método pos.order.get_vendas_caixa_dia (ticket 01).

    Fonte dos dados: pos.order direto (uma linha por cupom), não
    report.pos.order. A janela do dia é interpretada no fuso do usuário
    e convertida para UTC: [00:00 do dia, 00:00 do dia seguinte).
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company

        cls.caixa = cls.env["pos.config"].create({
            "name": "Caixa Teste Consulta",
            "company_id": cls.company.id,
        })
        cls.sessao = cls.env["pos.session"].create({
            "config_id": cls.caixa.id,
            "user_id": cls.env.uid,
        })
        cls.sessao.action_pos_session_open()

    def _criar_pedido(self, date_order, valor=100.0, state="paid",
                      sessao=None, nome=None):
        sessao = sessao or self.sessao
        return self.env["pos.order"].create({
            "session_id": sessao.id,
            "name": nome or "/",
            "date_order": date_order,
            "state": state,
            "amount_total": valor,
            "amount_tax": 0.0,
            "amount_paid": valor,
            "amount_return": 0.0,
        })

    def _consultar(self, data="2026-10-20", config_id=None):
        config_id = self.caixa.id if config_id is None else config_id
        return (
            self.env["pos.order"]
            .with_context(tz=TZ)
            .get_vendas_caixa_dia(config_id, data)
        )

    # ── Valor e granularidade ──────────────────────────────────────────────
    def test_uma_linha_por_cupom_com_valor_final(self):
        """Venda com vários itens e acréscimo global aparece uma vez só,
        com o amount_total final (não a soma dos itens)."""
        produto = self.env["product.product"].create({
            "name": "Produto Consulta",
            "list_price": 50.0,
        })
        pedido = self.env["pos.order"].create({
            "session_id": self.sessao.id,
            "date_order": "2026-10-20 13:00:00",
            "state": "paid",
            # 2 itens de 50 + acréscimo global de 10
            "x_amount_other_value": 10.0,
            "amount_total": 110.0,
            "amount_tax": 0.0,
            "amount_paid": 110.0,
            "amount_return": 0.0,
            "lines": [
                (0, 0, {
                    "product_id": produto.id,
                    "qty": 1,
                    "price_unit": 50.0,
                    "price_subtotal": 50.0,
                    "price_subtotal_incl": 50.0,
                }),
                (0, 0, {
                    "product_id": produto.id,
                    "qty": 1,
                    "price_unit": 50.0,
                    "price_subtotal": 50.0,
                    "price_subtotal_incl": 50.0,
                }),
            ],
        })

        resultado = self._consultar()

        self.assertEqual(len(resultado["vendas"]), 1)
        self.assertEqual(resultado["vendas"][0]["id"], pedido.id)
        self.assertEqual(resultado["vendas"][0]["valor"], 110.0)
        self.assertEqual(resultado["resumo"]["quantidade"], 1)

    # ── Fuso / fronteira do dia ────────────────────────────────────────────
    def test_fronteira_do_dia_no_fuso_do_usuario(self):
        """23:59:59 de Manaus (UTC-4) entra no dia pedido; 00:00 do dia
        seguinte e 23:59:59 da véspera ficam fora."""
        dentro = self._criar_pedido("2026-10-21 03:59:59")  # 20/10 23:59:59 local
        depois = self._criar_pedido("2026-10-21 04:00:00")  # 21/10 00:00 local
        antes = self._criar_pedido("2026-10-20 03:59:59")  # 19/10 23:59:59 local

        resultado = self._consultar("2026-10-20")
        ids = [venda["id"] for venda in resultado["vendas"]]

        self.assertEqual(ids, [dentro.id])
        self.assertNotIn(depois.id, ids)
        self.assertNotIn(antes.id, ids)

    # ── Estados ────────────────────────────────────────────────────────────
    def test_estados_incluidos(self):
        """paid/done/invoiced entram; draft e cancel ficam fora."""
        pagos = [
            self._criar_pedido("2026-10-20 12:00:00", state=state)
            for state in ("paid", "done", "invoiced")
        ]
        fora = [
            self._criar_pedido("2026-10-20 12:00:00", state=state)
            for state in ("draft", "cancel")
        ]

        resultado = self._consultar()
        ids = [venda["id"] for venda in resultado["vendas"]]

        self.assertEqual(sorted(ids), sorted(pedido.id for pedido in pagos))
        for pedido in fora:
            self.assertNotIn(pedido.id, ids)
        self.assertEqual(resultado["resumo"]["quantidade"], 3)

    # ── Sessões ────────────────────────────────────────────────────────────
    def test_multiplas_sessoes_do_mesmo_caixa(self):
        """Vendas em duas sessões do mesmo caixa/dia não se perdem nem
        duplicam."""
        pedido_a = self._criar_pedido("2026-10-20 09:00:00")

        # Sessão anterior do mesmo caixa, já fechada no mesmo dia.
        sessao_anterior = self.env["pos.session"].create({
            "config_id": self.caixa.id,
            "user_id": self.env.uid,
            "state": "closed",
        })
        pedido_b = self._criar_pedido(
            "2026-10-20 10:00:00", sessao=sessao_anterior
        )

        resultado = self._consultar()
        ids = [venda["id"] for venda in resultado["vendas"]]

        self.assertEqual(sorted(ids), sorted([pedido_a.id, pedido_b.id]))

    # ── Devolução ──────────────────────────────────────────────────────────
    def test_devolucao_negativa_no_dia_em_que_ocorreu(self):
        """Devolução entra com sinal negativo no dia em que ocorreu e é
        contada separadamente no resumo."""
        self._criar_pedido("2026-10-20 09:00:00", valor=100.0)
        devolucao = self._criar_pedido("2026-10-20 15:00:00", valor=-30.0)

        resultado = self._consultar()
        venda_devolvida = next(
            venda for venda in resultado["vendas"] if venda["id"] == devolucao.id
        )

        self.assertEqual(venda_devolvida["valor"], -30.0)
        self.assertEqual(resultado["resumo"]["quantidade"], 2)
        self.assertEqual(resultado["resumo"]["quantidade_devolucoes"], 1)
        totais = {total["currency_id"]: total["total"]
                  for total in resultado["resumo"]["totais"]}
        self.assertEqual(totais[self.caixa.currency_id.id], 70.0)

    # ── Resultado vazio / ordenação ────────────────────────────────────────
    def test_dia_sem_vendas(self):
        self._criar_pedido("2026-10-21 12:00:00")

        resultado = self._consultar("2026-10-20")

        self.assertEqual(resultado["vendas"], [])
        self.assertEqual(resultado["resumo"]["quantidade"], 0)
        self.assertEqual(resultado["resumo"]["totais"], [])

    def test_ordenacao_mais_recente_primeiro(self):
        antigo = self._criar_pedido("2026-10-20 09:00:00")
        recente = self._criar_pedido("2026-10-20 18:00:00")

        resultado = self._consultar()
        ids = [venda["id"] for venda in resultado["vendas"]]

        self.assertEqual(ids, [recente.id, antigo.id])

    # ── Acesso ─────────────────────────────────────────────────────────────
    def test_usuario_sem_acesso_nao_ve_vendas(self):
        """Sem sudo: usuário sem acesso ao PDV recebe erro de acesso em vez
        de ver as vendas. A consulta não contorna as record rules nativas."""
        self._criar_pedido("2026-10-20 12:00:00")

        usuario = self.env["res.users"].create({
            "name": "Usuaria Sem Acesso Consulta",
            "login": "sem_acesso_consulta_teste",
            "company_id": self.company.id,
            "company_ids": [(6, 0, [self.company.id])],
            "groups_id": [(6, 0, [self.env.ref("base.group_user").id])],
        })

        with self.assertRaises(AccessError):
            self.env["pos.order"].with_user(usuario).with_context(
                tz=TZ
            ).get_vendas_caixa_dia(self.caixa.id, "2026-10-20")

    # ── Entradas inválidas ─────────────────────────────────────────────────
    def test_caixa_invalido_gera_erro(self):
        with self.assertRaises(UserError):
            self._consultar(config_id=0)

    def test_caixa_inativo_nao_e_encontrado(self):
        caixa_inativo = self.env["pos.config"].create({
            "name": "Caixa Inativo Consulta",
            "company_id": self.company.id,
            "active": False,
        })

        with self.assertRaises(UserError):
            self._consultar(config_id=caixa_inativo.id)

    def test_data_invalida_gera_erro(self):
        with self.assertRaises(UserError):
            self._consultar("20/10/2026")
