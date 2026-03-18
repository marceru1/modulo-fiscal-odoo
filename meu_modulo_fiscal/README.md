# Módulo Fiscal — Odoo 18 PDV

Addon para o **Ponto de Venda do Odoo 18 Community** que adiciona toda a camada fiscal necessária pra emitir NFC-e.

Ele cuida de: cadastrar campos tributários nos produtos, capturar CPF/e-mail do consumidor na hora da venda, montar o payload fiscal, enviar pro middleware e receber o retorno com chave de acesso, QR Code e status da SEFAZ — tudo aparecendo no recibo térmico.

---

## O que ele faz

### Campos fiscais no produto
Cada produto ganha uma aba "Fiscal" com os campos obrigatórios pra nota:

- **NCM** (busca integrada com tabela do Mercosul)
- **CFOP** (5101, 5102, 5103)
- **Origem** da mercadoria
- **ICMS** (CST/CSOSN)
- **PIS** e **COFINS**

Esses dados são enviados junto com cada item da venda pro middleware.

### Código de barras automático (EAN-13)
Um botão no cadastro do produto gera um código de barras de 13 dígitos combinando:
- ID do produto (4 dígitos)
- Atributos da variante (Tamanho, Setor, Gênero, Tipo)
- Dígito verificador calculado automaticamente

Funciona tanto no template quanto na variante individual.

### Captura de CPF e E-mail no PDV
- Botão "CPF / Nota" na tela de pagamento (substitui o botão de fatura)
- Popup de e-mail aparece ao confirmar a venda
- Os dois dados ficam salvos no pedido e vão pro middleware

### Envio automático pro middleware
Quando o pagamento é confirmado, o addon monta um JSON com:
- Dados da venda (total, operador, referência)
- Itens com impostos (NCM, CFOP, ICMS, PIS, COFINS)
- Formas de pagamento
- CPF e e-mail do consumidor

Esse payload é enviado via HTTP pro middleware Laravel. O envio usa timeout curto (5s) pra nunca travar o caixa.

### Recibo DANFE personalizado
O recibo térmico foi totalmente customizado pra seguir o padrão DANFE NFC-e:
- Cabeçalho com dados do emitente
- Itens com código, descrição, quantidade e valor
- Totais e formas de pagamento com troco
- QR Code da nota (base64 renderizado direto na impressão)
- Chave de acesso e protocolo de autorização
- Tratamento visual de contingência ("Pendente de Autorização")
- Fallback pra recibo sem valor fiscal quando a nota não é emitida

### Webhook de retorno
O controller `/api/retorno-fiscal` recebe o callback do middleware com:
- Status da nota (autorizado, rejeitado, contingência, erro)
- Chave de acesso, protocolo, QR Code
- Flag de contingência offline

Os dados são gravados direto no pedido e o frontend JS faz polling até receber.

---

## Estrutura

```
meu_modulo_fiscal/
├── controllers/
│   └── fiscal_controller.py    # Webhook que recebe retorno do middleware
├── models/
│   ├── campos_fiscais.py       # Campos tributários no cadastro de produto
│   ├── pos_order.py            # Envio da venda pro middleware + loader de campos
│   └── recursos_variantes.py   # Badges de variante + geração de EAN-13
├── static/src/
│   ├── js/
│   │   ├── confirm_popup.js    # Popup de confirmação + polling de status fiscal
│   │   ├── cpf_popup.js        # Captura de CPF no pagamento
│   │   └── export_data.js      # Serialização dos campos fiscais pro recibo
│   ├── xml/
│   │   ├── cpf_button.xml      # Botão CPF na tela de pagamento
│   │   └── order_receipt.xml   # Template DANFE do recibo térmico
│   └── css/
│       └── order_receipt.css   # Estilos do recibo fiscal
├── views/
│   └── campos_fiscais_views.xml # Formulário fiscal no cadastro de produto
├── data/
│   └── br.ncm.csv              # Tabela NCM importada automaticamente
└── __manifest__.py
```



## Dependências

- `product` (nativo do Odoo)
- `point_of_sale` (nativo do Odoo)

> **Importante:** Este módulo não emite nota fiscal sozinho.
> Ele prepara, envia e recebe os dados fiscais, delegando a emissão a um middleware externo (Laravel + Focus NFe).
