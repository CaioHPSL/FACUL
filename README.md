# FACUL - Sistema de Controle de Laboratório

Sistema web simples para controle de pedidos, amostras, clientes, funcionários, laudos e resultados de um laboratório.

O projeto foi desenvolvido como trabalho acadêmico, usando Node.js no backend, SQLite como banco de dados local e páginas HTML/CSS/JavaScript no frontend.

## Funcionalidades

- Login de cliente por CPF
- Login de funcionário por nome e senha
- Cadastro de clientes
- Cadastro de funcionários
- Criação de pedidos
- Cadastro de amostras por pedido
- Pesquisa de pedidos
- Pesquisa de amostras
- Registro e visualização de laudos/resultados
- Separação entre painel do cliente e painel do funcionário

## Tecnologias utilizadas

- Node.js
- Express
- SQLite
- HTML
- CSS
- JavaScript
- JSON Web Token para autenticação
- Bcrypt para proteção de senhas

## Estrutura do projeto

```text
FACUL/
├── public/
│   ├── app.css
│   ├── index.html
│   ├── painel-cliente.html
│   └── painel-funcionario.html
├── banco_laboratorio.db
├── package.json
├── package-lock.json
├── server.js 
└── README.md

```

## Como executar o projeto

Primeiro, instale as dependências:

npm install

Depois, inicie o servidor:

npm start

O sistema ficará disponível no navegador pelo endereço:

http://localhost:3000
Acesso inicial

Para acessar como funcionário, use:

Nome: Funcionário Teste
Senha: PA1406

Para acessar como cliente, é necessário que o CPF já esteja cadastrado no sistema.

Banco de dados

O projeto utiliza SQLite com o arquivo:

banco_laboratorio.db

As tabelas principais são criadas automaticamente pelo sistema caso ainda não existam.

Observações

Este projeto foi feito para fins acadêmicos.
Os dados usados são fictícios e não devem representar informações reais de clientes.
