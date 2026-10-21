from datetime import date, timedelta

from odoo.exceptions import AccessError, UserError
from odoo.tests.common import TransactionCase

TZ = "America/Manaus"
DIA_PADRAO = "2026-10-20"


class TestConsultaVendasCaixaDia(TransactionCase):
    """Contrato do método pos.order.get_vendas_caixa_dia (ticket 01).

    Fonte dos dados: pos.order direto (uma linha por cupom), não
    report.pos.order. Cada dia marcado é uma janela interpretada no fuso do
    usuário e convertida para UTC: [00:00 do dia, 00:00 do dia seguinte),
    e as janelas dos dias avulsos são unidas por OU (DEC-008).
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company

        # Métodos precisam entrar na config ANTES de abrir a sessão (o core
        # não deixa alterar payment methods com sessão aberta).
        cls.metodo_dinheiro = cls.env["pos.payment.method"].create({
            "name": "Dinheiro",
            "company_id": cls.company.id,
        })
        cls.metodo_cartao = cls.env["pos.payment.method"].create({
            "name": "Cartão",
            "company_id": cls.company.id,
        })
        cls.caixa = cls.env["pos.config"].create({
            "name": "Caixa Teste Consulta",
            "company_id": cls.company.id,
            "payment_method_ids": [
                (4, cls.metodo_dinheiro.id),
                (4, cls.metodo_cartao.id),
            ],
        })
        cls.sessao = cls.env["pos.session"].create({
            "config_id": cls.caixa.id,
            "user_id": cls.env.uid,
        })
        cls.sessao.action_pos_session_open()

    def _pagar(self, pedido, metodo, valor):
        return self.env["pos.payment"].create({
            "pos_order_id": pedido.id,
            "payment_method_id": metodo.id,
            "amount": valor,
        })

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

    def _consultar(self, datas=None, config_id=None):
        config_id = self.caixa.id if config_id is None else config_id
        if datas is None:
            datas = [DIA_PADRAO]
        return (
            self.env["pos.order"]
            .with_context(tz=TZ)
            .get_vendas_caixa_dia(config_id, datas)
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

        resultado = self._consultar(["2026-10-20"])
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

        resultado = self._consultar(["2026-10-20"])

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
            ).get_vendas_caixa_dia(self.caixa.id, ["2026-10-20"])

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
            self._consultar(["20/10/2026"])

    # ── Dias avulsos (DEC-008) ─────────────────────────────────────────────
    def test_uniao_de_dias_com_dia_vazio_no_meio(self):
        """Dias avulsos são unidos por OU: um dia marcado sem vendas no meio
        do conjunto não omite nem duplica os demais dias."""
        dia_19 = self._criar_pedido("2026-10-19 12:00:00", valor=10.0)
        dia_21 = self._criar_pedido("2026-10-21 12:00:00", valor=25.0)
        dia_20 = self._criar_pedido("2026-10-20 12:00:00", valor=99.0)

        resultado = self._consultar(["2026-10-19", "2026-10-21", "2026-10-20"])
        ids = [venda["id"] for venda in resultado["vendas"]]

        # 20/10 também foi marcado neste caso; o teste do "buraco" é o de baixo.
        self.assertEqual(sorted(ids), sorted([dia_19.id, dia_20.id, dia_21.id]))

        buraco = self._consultar(["2026-10-19", "2026-10-21"])
        ids_buraco = [venda["id"] for venda in buraco["vendas"]]
        self.assertEqual(sorted(ids_buraco), sorted([dia_19.id, dia_21.id]))
        self.assertEqual(buraco["resumo"]["quantidade"], 2)
        self.assertEqual(buraco["datas"], ["2026-10-19", "2026-10-21"])

    def test_meia_noite_em_dia_especifico_do_conjunto(self):
        """A janela é fechada por dia: 00:00 de um dia marcado entra nele e
        não vaza para o dia anterior — mesmo quando o dia anterior também
        está marcado e o dia do meio não está."""
        vespera_do_19 = self._criar_pedido("2026-10-19 23:59:59")  # 19/10 19:59:59 local
        meia_noite_20 = self._criar_pedido("2026-10-20 04:00:00")  # 20/10 00:00 local
        dentro_do_19 = self._criar_pedido("2026-10-20 03:59:59")   # 19/10 23:59:59 local
        meia_noite_21 = self._criar_pedido("2026-10-21 04:00:00")  # 21/10 00:00 local

        resultado = self._consultar(["2026-10-19", "2026-10-21"])
        ids = [venda["id"] for venda in resultado["vendas"]]

        self.assertIn(vespera_do_19.id, ids)      # 19/10 19:59 local
        self.assertIn(dentro_do_19.id, ids)       # 19/10 23:59:59 local
        self.assertIn(meia_noite_21.id, ids)      # 21/10 00:00 local
        self.assertNotIn(meia_noite_20.id, ids)   # 20/10 não foi marcado

    def test_mais_de_31_dias_gera_erro_sem_resultado_parcial(self):
        """32 dias marcados estouram a guarda: erro claro, sem devolver o
        subconjunto que já teria sido encontrado."""
        self._criar_pedido("2026-10-01 12:00:00")
        dias = [
            (date(2026, 10, 1) + timedelta(days=indice)).isoformat()
            for indice in range(32)
        ]

        with self.assertRaises(UserError):
            self._consultar(dias)

    def test_31_dias_e_o_limite_aceito(self):
        alvo = self._criar_pedido("2026-10-31 12:00:00")
        dias = [
            (date(2026, 10, 1) + timedelta(days=indice)).isoformat()
            for indice in range(31)
        ]

        resultado = self._consultar(dias)

        self.assertEqual([venda["id"] for venda in resultado["vendas"]], [alvo.id])
        self.assertEqual(resultado["resumo"]["quantidade"], 1)

    def test_dias_repetidos_nao_duplicam_vendas(self):
        pedido = self._criar_pedido("2026-10-20 12:00:00")

        resultado = self._consultar(["2026-10-20", "2026-10-20"])

        self.assertEqual([venda["id"] for venda in resultado["vendas"]], [pedido.id])
        self.assertEqual(resultado["resumo"]["quantidade"], 1)
        self.assertEqual(resultado["datas"], ["2026-10-20"])

    def test_lista_de_dias_vazia_gera_erro(self):
        with self.assertRaises(UserError):
            self._consultar([])

    def test_resumo_por_moeda_do_conjunto_nao_soma_moedas_diferentes(self):
        """O resumo agrupa por moeda — o total de uma moeda nunca é somado
        ao de outra. Um pos.config tem uma moeda só (related), então o
        contrato é exercitado direto no agregador."""
        brl = self.env.ref("base.BRL")
        usd = self.env.ref("base.USD")
        vendas = [
            {"currency_id": brl.id, "moeda": brl.name, "valor": 40.0},
            {"currency_id": usd.id, "moeda": usd.name, "valor": 10.0},
            {"currency_id": brl.id, "moeda": brl.name, "valor": -5.0},
        ]

        totais = self.env["pos.order"]._totais_por_moeda(vendas)
        por_moeda = {total["currency_id"]: total["total"] for total in totais}

        self.assertEqual(por_moeda[brl.id], 35.0)
        self.assertEqual(por_moeda[usd.id], 10.0)
        self.assertEqual(len(totais), 2)

    # ── Formas de pagamento e colunas (DEC-009) ────────────────────────────
    def test_cupom_com_um_metodo_de_pagamento(self):
        """Pagamento único mostra o nome do método do cupom."""
        pedido = self._criar_pedido("2026-10-20 09:00:00")
        self._pagar(pedido, self.metodo_dinheiro, 100.0)

        resultado = self._consultar()

        self.assertEqual(resultado["vendas"][0]["formas_pagamento"], "Dinheiro")

    def test_cupom_dividido_une_metodos_distintos(self):
        """Pagamento dividido une os métodos DISTINTOS, na ordem dos
        pagamentos, sem repetir método usado duas vezes."""
        pedido = self._criar_pedido("2026-10-20 10:00:00")
        self._pagar(pedido, self.metodo_dinheiro, 40.0)
        self._pagar(pedido, self.metodo_cartao, 60.0)
        self._pagar(pedido, self.metodo_dinheiro, 5.0)

        resultado = self._consultar()

        self.assertEqual(
            resultado["vendas"][0]["formas_pagamento"], "Dinheiro + Cartão"
        )

    def test_cupom_sem_pagamento_tem_forma_vazia(self):
        self._criar_pedido("2026-10-20 11:00:00")

        resultado = self._consultar()

        self.assertEqual(resultado["vendas"][0]["formas_pagamento"], "")

    def test_retorno_sem_cliente_e_sem_situacao(self):
        """DEC-009: partner_id e state saem do retorno (e o rótulo junto)."""
        pedido = self._criar_pedido("2026-10-20 12:00:00")
        self._pagar(pedido, self.metodo_dinheiro, 100.0)

        venda = self._consultar()["vendas"][0]

        for campo in ("cliente", "partner_id", "state", "situacao"):
            self.assertNotIn(campo, venda)
        self.assertEqual(venda["formas_pagamento"], "Dinheiro")

    def test_resumo_arredonda_residuo_float_por_moeda(self):
        """Somar centavos não devolve resíduo de float: o total de cada moeda
        sai arredondado pela precisão dela (decimal_places do res.currency)."""
        # A consulta acumula em date_order desc: 10:00 (0.2) antes de 09:00 (0.1).
        self._criar_pedido("2026-10-20 09:00:00", valor=0.1)
        self._criar_pedido("2026-10-20 10:00:00", valor=0.2)
        # O resíduo existe no acumulador float antes de arredondar.
        self.assertNotEqual(0.2 + 0.1, 0.3)

        resultado = self._consultar()
        totais = resultado["resumo"]["totais"]

        self.assertEqual(len(totais), 1)
        self.assertEqual(totais[0]["total"], 0.3)
        self.assertEqual(resultado["resumo"]["quantidade"], 2)
