# Módulo Fiscal – Odoo 18

Este módulo adiciona funcionalidades fiscais básicas ao **Ponto de Venda (PDV)** do **Odoo 18 Community**.

Ele está sendo desenvolvido para atuar como o **ponto final de uma loja (caixa)**, concentrando as informações fiscais da venda, coletando dados obrigatórios do consumidor e integrando o Odoo a um **middleware fiscal externo**.

---

## Objetivo Geral

- Centralizar informações fiscais no cadastro de produtos
- Coletar CPF e E-mail do consumidor no momento da venda
- Estruturar o payload fiscal da venda
- Enviar os dados da venda para um middleware fiscal
- Receber o retorno do middleware para exibição/impressão no cupom

---

## Funcionalidades

### Campos Fiscais no Produto (`campos_fiscais.py`)
Inclusão de campos puramente fiscais diretamente no cadastro de produtos para emissão da nota:

- NCM
- CFOP
- Origem da mercadoria
- ICMS (CST / CSOSN)
- PIS
- COFINS

Esses campos são utilizados na composição do payload fiscal enviado ao middleware.

### Geração de Códigos de Barras Automática (`recursos_variantes.py`)
Adicionamos lógicas dedicadas especificamente à gestão de Variantes de Produto de forma separada (`recursos_variantes.py`). Funcionalidades incluem:

- **Badges de Atributos**: Exibe de forma visual os atributos (ex: Cor, Tamanho) associados a uma variante tanto na árvore listagem (`tree`) quanto dentro do cabeçalho do formulário.
- **Botão Inteligente de EAN-13**: Um botão no formulário do produto ("Gerar Código") que avalia de modo inteligente as tags de atributos de um produto (ex: Tamanho, Setor, Gênero e Tipo de Produto) e monta automaticamente um **código de barras EAN-13 de 13 dígitos** combinando:
  - O código/ID do produto base (4 dígitos)
  - IDs dos valores respectivos dos atributos 
  - Cálculo automático do dígito verificador `(check_digit)` EAN-13
  
  Essa lógica poupa tempo operacional e diminui a chance de erro humano na codificação das variantes

---

### Ponto de Venda

Durante o processo de venda no PDV:

- Captura de informações adicionais:
  - CPF do consumidor na nota
  - Email do cliente para envio da nota fiscal
- Armazenamento desses dados diretamente na ordem de venda (`pos.order`)

---

###Integração com Middleware Fiscal

Ao finalizar o pagamento no PDV:

- Os dados da venda são estruturados em um payload JSON
- O payload contém:
  - Dados da venda
  - Produtos e respectivos impostos
  - Formas de pagamento
  - Dados do cliente
- O JSON é enviado via HTTP (API REST) para um middleware externo

O middleware é responsável por:
- Processar as regras fiscais
- Comunicar-se com a API fiscal (ex: NFC-e / NF-e)
- Retornar o resultado da operação ao Odoo

---


> Este módulo **não realiza a emissão fiscal diretamente**.  
> Ele apenas prepara, envia e recebe os dados fiscais, delegando a emissão a um middleware especializado.

---

## Contexto de Uso

Este módulo foi projetado para cenários onde:
- O Odoo é utilizado como **PDV final (caixa)**
- A emissão fiscal é feita por um **serviço externo**
- Existe a necessidade de flexibilidade e desacoplamento da lógica fiscal

