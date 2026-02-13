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

### Campos Fiscais no Produto
Inclusão de campos fiscais diretamente no cadastro de produtos:

- NCM
- CFOP
- Origem da mercadoria
- ICMS (CST / CSOSN)
- PIS
- COFINS

Esses campos são utilizados na composição do payload fiscal enviado ao middleware.

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

