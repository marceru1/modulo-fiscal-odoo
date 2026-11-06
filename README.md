# Módulo Fiscal Brasil — NFC-e

[![Odoo](https://img.shields.io/badge/Odoo-18-blueviolet)](https://www.odoo.com)
![Ponto de venda](https://img.shields.io/badge/foco-Point%20of%20Sale-teal)

Controle tributário completo no Odoo 18 (NCM, CFOP, PIS/COFINS) e emissão de
NFC-e direto no PDV, integrado a um [middleware Laravel](https://github.com/marceru1/middleware_nfce)
com a API da Focus NFe.

## O que o módulo faz

- **Tributação nos produtos** — NCM (tabela completa carregada por CSV), CFOP
  e PIS/COFINS por produto/variante, com configuração central nas Configurações.
- **NFC-e no PDV** — a venda sai do POS para o middleware, que assina (certificado
  A1), transmite e devolve status. Contingência offline implementada no JavaScript
  do POS, com QR code no cupom.
- **Etiquetas de produto** — wizard de impressão em QWeb com layouts por linha
  de produto, respeitando folha pré-impressa e múltiplas etiquetas por página.
- **Venda A Prazo** — crédito no PDV por funcionário: cota, registro de pagamento
  com fatura vinculada no histórico (backfill idempotente a cada upgrade).
- **Fechamento e gestão de caixa** — reimpressão do fechamento em HTML válido,
  consulta de vendas por caixa/dia e análise de pedidos.
- **Operação no PDV** — atalhos por teclado (só letras, nunca dígitos — o teclado
  numérico é do operador), cupom customizado e ajustes de layout nas telas do POS.

## Arquitetura

```
Odoo 18 (POS) ──webhook──▶ Middleware NFC-e (Laravel 12) ──▶ Focus NFe ──▶ SEFAZ
     ▲                                                            │
     └──────────── status, eventos e contingência ◀───────────────┘
```

O módulo cuida do lado Odoo (dados fiscais, fluxo de venda, contingência, impressão).
Assinatura, transmissão e eventos fiscais rodam no middleware — que também é open source.

## Instalação

```bash
git clone https://github.com/marceru1/modulo-fiscal-odoo.git
# coloque a pasta no addons_path da sua instância Odoo 18
# Apps → Atualizar lista → instalar "Módulo Fiscal Brasil - NFC-e"
```

A tabela NCM carrega a partir de `meu_modulo_fiscal/data/br.ncm.csv`. Para
desenvolvimento/servidor, há `Dockerfile`, `odoo.conf.docker` e `start.sh` no repositório.

## Testes

```bash
# login de teste em bases já populadas:
export MFISCAL_TEST_LOGIN=seu_login
odoo-bin -d sua_base --test-enable --stop-after-init -u meu_modulo_fiscal
```

## Estado

Em desenvolvimento ativo, em uso em operação real de PDV. Próximos passos:
NF-e modelo 55 e mais cobertura nos eventos fiscais.

## Licença

A definir (candidata: MIT). Consulte antes de usar em produção.
