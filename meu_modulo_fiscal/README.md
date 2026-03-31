# 🧾 Módulo Fiscal — Odoo 18 PDV (Integração NFC-e)

Addon desenvolvido para o **Ponto de Venda do Odoo 18 Community** que adiciona a camada fiscal necessária para emissão de NFC-e (Nota Fiscal de Consumidor Eletrônica) através de um Middleware (Focus NFe).

Ele é responsável por:
* ✔️ Cadastrar campos tributários essenciais nos produtos (NCM, CFOP, Origem);
* ✔️ Capturar o CPF e E-mail do consumidor na hora da venda (Popup POS);
* ✔️ Montar o payload fiscal contendo os tributos do item e enviar os dados para o Middleware;
* ✔️ Capturar o retorno do Webhook (Status, QR Code, Chave de Acesso) e renderizar no Recibo Térmico (DANFE).

---

## 🚀 Principais Funcionalidades

### 📦 Campos Fiscais Nativos no Produto
Cada produto (`product.template`) recebe novos campos essenciais para emissão fiscal no Brasil:
- **NCM** (Nomenclatura Comum do Mercosul) com tabela relacional auto-populada;
- **CFOP** (Código Fiscal de Operações e Prestações);
- **Origem** tributária da mercadoria;
- **ICMS, PIS e COFINS** (CST/CSOSN).

Esses dados são injetados automaticamente no fluxo de venda na finalização do pedido no caixa.

### 🔢 Código de Barras Automático (EAN-13)
Visando automatizar lojas com muitas variações, o módulo possibilita gerar códigos de barras em lote:
- Cria códigos rastreáveis de 13 dígitos aproveitando o ID do banco de dados (PostgreSQL);
- Possui Action para gerar os códigos em cascata, desde o *Template* até as *Variantes (Product)*;
- Inclui validação nativa de Checksum (Dígito Verificador EAN-13).

### 🏷️ Captura ágil no PDV (CPF na Nota)
- Botão "CPF / Nota" injetado direto na tela de pagamento (OWL JS);
- Popup customizado que coleta o CPF do cliente e o E-mail para envio posterior pelo ERP;
- Dados salvos em sessão e despachados via API em tempo real.

### 🔌 Comunicação Assíncrona com Middleware
Quando a venda (Pos_Order) é confirmada, o addon monta um Payload JSON robusto e performático:
- Inclui lista de produtos e impostos atrelados;
- Calcula descontos comerciais via Odoo e os traduz para descontos fiscais aceitos na Sefaz;
- Previne lentidão no PDV local implementando Timeouts de resposta HTTP de até 5 segundos;
- Caso o Middleware esteja offline (Timeout), a venda conclui localmente no ERP e a nota fica "Pendente" (Contingência).

### 🖨️ DANFE NFC-e Impresso Localmente
O recibo térmico base do Odoo foi sobrescrito para gerar conformidade visual com o Layout DANFE NFC-e da Receita Federal:
- QRCode Base64 gerado pelo Focus/Sefaz e injetado via Polling no recibo (`order_receipt.xml`);
- Exibe mensagens de Controle, Chave de Acesso e Protocolo;
- Renderiza avisos explícitos de "Emitido em ContingênciaOffline" se o webhook apontar falha temporária.

### 🎣 Webhook de Retorno Integrado
Um Controller Python `/api/retorno-fiscal` exposto na porta 8069 captura os Fallbacks do Laravel indicando se:
- `Autorizado:` Venda legalizada e pronta pra entrega;
- `Rejeitado:` Exibe no Backoffice (Pos_Order) a mensagem de correção da Sefaz;
- `Contingência:` Mantém o registro guardado até segunda ordem do Middleware.

---

## 📂 Estrutura de Diretórios

O módulo mantém a arquitetura MVCC do Odoo:

```plaintext
meu_modulo_fiscal/
├── controllers/          # Rotas expostas para o Webhook do Laravel
├── data/                 # Tabelas CSV importadas automaticamente (Ex: br.ncm)
├── models/               # Extensões do Banco de Dados (Product, Pos.Order)
├── static/src/           # Frontend OWL (Point of Sale JS/XML Customizado)
│   ├── css/              # Folhas de estilo do DANFE térmico
│   ├── js/               # Lógicas de Polling, Telas Modais e Captura Fiscal
│   └── xml/              # Templates renderizados no navegador (Recibos, Botões)
└── views/                # Telas de Injeção no Backoffice (Abas de Faturamento ERP)
```

## 🛠️ Dependências

- `product` (Odoo Core Base)
- `point_of_sale` (Odoo POS App)

> **⚠️ Importante:** Este addon isolado **não possui certificados A1** e nem assina os retornos XML por conta própria. Ele serve como a Interface (View/Model) que organiza o ERP e comanda o envio/recepção dos dados à um ecossistema de infraestrutura externo (Middleware Laravel + Focus NFe).

