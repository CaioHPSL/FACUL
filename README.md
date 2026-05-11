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
