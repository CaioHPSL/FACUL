const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'banco_laboratorio.db');
const SECRET_KEY = process.env.SECRET_KEY || 'chave_secreta_laboratorio_2026';

const TIPOS_AMOSTRA = [
    'Fertilizante',
    'Semente',
    'Solo',
    'Nematoide',
    'Bromatológica',
    'Composto Orgânico'
];

const STATUS_AMOSTRA = ['Pendente', 'Em análise', 'Concluído', 'Entregue'];
const STATUS_FUNCIONARIO = ['Pendente', 'Em análise', 'Concluído'];

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error(err.message);
    else console.log(`Conectado ao banco SQLite: ${DB_PATH}`);
});

db.configure('busyTimeout', 5000);

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function withTransaction(callback) {
    await run('BEGIN IMMEDIATE');
    try {
        const result = await callback();
        await run('COMMIT');
        return result;
    } catch (err) {
        await run('ROLLBACK').catch(() => {});
        throw err;
    }
}

function erro(status, mensagem) {
    const err = new Error(mensagem);
    err.status = status;
    return err;
}

function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function texto(valor) {
    return typeof valor === 'string' ? valor.trim() : '';
}

function normalizarCpf(valor) {
    return texto(valor).replace(/\D/g, '');
}

function normalizarDocumento(valor) {
    return normalizarCpf(valor);
}

function normalizarNome(valor) {
    return texto(valor)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function dataAgora() {
    return new Date().toISOString();
}

function anoAtual() {
    return new Date().getFullYear();
}

function numeroPedidoFormatado(sequencial, ano) {
    return `${String(sequencial).padStart(4, '0')}/${ano}`;
}

function codigoFuncionario() {
    return `FUNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function validarTipo(tipo) {
    const tipoLimpo = texto(tipo);
    if (!TIPOS_AMOSTRA.includes(tipoLimpo)) {
        throw erro(400, 'Tipo de amostra inválido.');
    }
    return tipoLimpo;
}

function validarStatus(status, permitidos = STATUS_AMOSTRA) {
    const statusLimpo = texto(status);
    if (!permitidos.includes(statusLimpo)) {
        throw erro(400, 'Status da análise inválido.');
    }
    return statusLimpo;
}

function calcularStatusGeral(statuses) {
    if (!statuses.length) return 'Sem amostras';

    const unicos = [...new Set(statuses)];
    if (unicos.length === 1) return unicos[0];
    if (statuses.includes('Em análise')) return 'Em análise';
    return 'Parcial';
}

function ordenarTipos(tipos) {
    return [...new Set(tipos)].sort((a, b) => {
        return TIPOS_AMOSTRA.indexOf(a) - TIPOS_AMOSTRA.indexOf(b);
    });
}

async function tabelaExiste(nome) {
    const row = await get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [nome]
    );
    return Boolean(row);
}

async function colunasTabela(nome) {
    const rows = await all(`PRAGMA table_info(${nome})`);
    return rows.map((row) => row.name);
}

async function adicionarColunaSeNaoExiste(tabela, coluna, definicao) {
    const colunas = await colunasTabela(tabela);
    if (!colunas.includes(coluna)) {
        await run(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
    }
}

async function criarTabelaAmostras(nome = 'amostras') {
    await run(`CREATE TABLE IF NOT EXISTS ${nome} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pedido_id INTEGER NOT NULL,
        numero_amostra INTEGER NOT NULL,
        identificacao_amostra TEXT NOT NULL,
        tipo_amostra TEXT NOT NULL CHECK(tipo_amostra IN ('Fertilizante', 'Semente', 'Solo', 'Nematoide', 'Bromatológica', 'Composto Orgânico')),
        status TEXT NOT NULL DEFAULT 'Pendente' CHECK(status IN ('Pendente', 'Em análise', 'Concluído', 'Entregue')),
        laudo TEXT,
        cpf_cliente TEXT NOT NULL,
        nome_cliente TEXT NOT NULL,
        data_cadastro TEXT NOT NULL,
        data_entrega TEXT,
        FOREIGN KEY(pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
        UNIQUE(tipo_amostra, numero_amostra)
    )`);
}

async function upsertCliente(cpf, nome, endereco = '', extras = {}) {
    await run(
        `INSERT INTO clientes (cpf, nome, endereco, telefone, email, nome_fazenda)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(cpf) DO UPDATE SET
            nome = excluded.nome,
            endereco = CASE
                WHEN excluded.endereco <> '' THEN excluded.endereco
                ELSE clientes.endereco
            END,
            telefone = CASE
                WHEN excluded.telefone <> '' THEN excluded.telefone
                ELSE clientes.telefone
            END,
            email = CASE
                WHEN excluded.email <> '' THEN excluded.email
                ELSE clientes.email
            END,
            nome_fazenda = CASE
                WHEN excluded.nome_fazenda <> '' THEN excluded.nome_fazenda
                ELSE clientes.nome_fazenda
            END`,
        [
            cpf,
            nome,
            endereco,
            texto(extras.telefone),
            texto(extras.email),
            texto(extras.nome_fazenda)
        ]
    );
}

async function criarPedidoNoBanco({ cpf, nome, dataCadastro = dataAgora() }) {
    const ano = new Date(dataCadastro).getFullYear() || anoAtual();
    const ultimo = await get(
        `SELECT MAX(CAST(SUBSTR(numero_pedido, 1, 4) AS INTEGER)) AS sequencial
         FROM pedidos
         WHERE ano = ?`,
        [ano]
    );
    const proximo = Number(ultimo?.sequencial || 0) + 1;
    const numeroPedido = numeroPedidoFormatado(proximo, ano);

    const result = await run(
        `INSERT INTO pedidos (numero_pedido, ano, cpf_cliente, nome_cliente, data_cadastro)
         VALUES (?, ?, ?, ?, ?)`,
        [numeroPedido, ano, cpf, nome, dataCadastro]
    );

    return getPedidoResumoPorId(result.lastID);
}

async function adicionarAmostraNoBanco(pedidoId, dados) {
    const pedido = await get('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
    if (!pedido) throw erro(404, 'Pedido não encontrado.');

    const identificacao = texto(dados.identificacao_amostra);
    if (!identificacao) throw erro(400, 'Identificação da amostra é obrigatória.');

    const tipo = validarTipo(dados.tipo_amostra);
    const ultimo = await get(
        `SELECT MAX(numero_amostra) AS numero
         FROM amostras
         WHERE tipo_amostra = ?`,
        [tipo]
    );
    const numeroAmostra = Number(ultimo?.numero || 0) + 1;

    const result = await run(
        `INSERT INTO amostras (
            pedido_id, numero_amostra, identificacao_amostra, tipo_amostra,
            status, laudo, cpf_cliente, nome_cliente, data_cadastro, data_entrega
         )
         VALUES (?, ?, ?, ?, 'Pendente', ?, ?, ?, ?, NULL)`,
        [
            pedido.id,
            numeroAmostra,
            identificacao,
            tipo,
            texto(dados.laudo),
            pedido.cpf_cliente,
            pedido.nome_cliente,
            dataAgora()
        ]
    );

    return getAmostraCompleta(result.lastID);
}

async function getPedidoResumoPorId(id) {
    const rows = await consultarPedidos({ id });
    return rows[0];
}

async function getAmostraCompleta(id) {
    return get(
        `SELECT
            a.*,
            p.numero_pedido,
            p.ano,
            p.data_cadastro AS data_cadastro_pedido
         FROM amostras a
         JOIN pedidos p ON p.id = a.pedido_id
         WHERE a.id = ?`,
        [id]
    );
}

function montarFiltrosPedido(filtros = {}, cpfObrigatorio = null) {
    const where = [];
    const params = [];
    const exists = [];
    const existsParams = [];

    if (filtros.id) {
        where.push('p.id = ?');
        params.push(filtros.id);
    }

    if (cpfObrigatorio) {
        where.push('p.cpf_cliente = ?');
        params.push(cpfObrigatorio);
    } else if (normalizarCpf(filtros.cpf)) {
        where.push('p.cpf_cliente = ?');
        params.push(normalizarCpf(filtros.cpf));
    }

    if (texto(filtros.numero_pedido)) {
        where.push('p.numero_pedido = ?');
        params.push(texto(filtros.numero_pedido));
    }

    if (texto(filtros.numero_amostra)) {
        const numero = Number(texto(filtros.numero_amostra));
        if (!Number.isInteger(numero) || numero <= 0) {
            throw erro(400, 'Número da amostra deve ser numérico.');
        }
        exists.push('ax.numero_amostra = ?');
        existsParams.push(numero);
    }

    if (texto(filtros.tipo_amostra)) {
        exists.push('ax.tipo_amostra = ?');
        existsParams.push(validarTipo(filtros.tipo_amostra));
    }

    if (exists.length) {
        where.push(`EXISTS (
            SELECT 1
            FROM amostras ax
            WHERE ax.pedido_id = p.id
              AND ${exists.join(' AND ')}
        )`);
        params.push(...existsParams);
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        params
    };
}

async function consultarPedidos(filtros = {}, cpfObrigatorio = null) {
    const { whereSql, params } = montarFiltrosPedido(filtros, cpfObrigatorio);
    const rows = await all(
        `SELECT
            p.id AS pedido_id,
            p.numero_pedido,
            p.ano,
            p.cpf_cliente,
            p.nome_cliente,
            p.data_cadastro AS pedido_data_cadastro,
            a.id AS amostra_id,
            a.numero_amostra,
            a.identificacao_amostra,
            a.tipo_amostra,
            a.status
         FROM pedidos p
         LEFT JOIN amostras a ON a.pedido_id = p.id
         ${whereSql}
         ORDER BY p.data_cadastro DESC, p.id DESC, a.tipo_amostra ASC, a.numero_amostra ASC`,
        params
    );

    const porPedido = new Map();
    for (const row of rows) {
        if (!porPedido.has(row.pedido_id)) {
            porPedido.set(row.pedido_id, {
                id: row.pedido_id,
                numero_pedido: row.numero_pedido,
                ano: row.ano,
                cpf_cliente: row.cpf_cliente,
                nome_cliente: row.nome_cliente,
                data_cadastro: row.pedido_data_cadastro,
                amostras: []
            });
        }

        if (row.amostra_id) {
            porPedido.get(row.pedido_id).amostras.push({
                id: row.amostra_id,
                numero_amostra: row.numero_amostra,
                identificacao_amostra: row.identificacao_amostra,
                tipo_amostra: row.tipo_amostra,
                status: row.status
            });
        }
    }

    return [...porPedido.values()].map((pedido) => {
        const tipos = ordenarTipos(pedido.amostras.map((amostra) => amostra.tipo_amostra));
        const statuses = pedido.amostras.map((amostra) => amostra.status);
        return {
            id: pedido.id,
            numero_pedido: pedido.numero_pedido,
            ano: pedido.ano,
            cpf_cliente: pedido.cpf_cliente,
            nome_cliente: pedido.nome_cliente,
            data_cadastro: pedido.data_cadastro,
            tipos_amostra: tipos.length ? tipos.join(', ') : 'Sem amostras',
            status_geral: calcularStatusGeral(statuses),
            total_amostras: pedido.amostras.length
        };
    });
}

async function consultarPedidoDetalhado(id, cpfObrigatorio = null, incluirLaudo = true) {
    const pedido = await get(
        `SELECT *
         FROM pedidos
         WHERE id = ?
         ${cpfObrigatorio ? 'AND cpf_cliente = ?' : ''}`,
        cpfObrigatorio ? [id, cpfObrigatorio] : [id]
    );
    if (!pedido) throw erro(404, 'Pedido não encontrado.');

    const camposLaudo = incluirLaudo ? ', laudo, data_entrega' : ', data_entrega';
    const amostras = await all(
        `SELECT
            id,
            pedido_id,
            numero_amostra,
            identificacao_amostra,
            tipo_amostra,
            status,
            cpf_cliente,
            nome_cliente,
            data_cadastro
            ${camposLaudo}
         FROM amostras
         WHERE pedido_id = ?
         ORDER BY tipo_amostra ASC, numero_amostra ASC`,
        [pedido.id]
    );

    return { pedido, amostras };
}

function montarFiltrosAmostras(filtros = {}, cpfObrigatorio = null) {
    const where = [];
    const params = [];

    if (cpfObrigatorio) {
        where.push('a.cpf_cliente = ?');
        params.push(cpfObrigatorio);
    } else if (normalizarCpf(filtros.cpf)) {
        where.push('a.cpf_cliente = ?');
        params.push(normalizarCpf(filtros.cpf));
    }

    if (texto(filtros.numero_pedido)) {
        where.push('p.numero_pedido = ?');
        params.push(texto(filtros.numero_pedido));
    }

    if (texto(filtros.numero_amostra)) {
        const numero = Number(texto(filtros.numero_amostra));
        if (!Number.isInteger(numero) || numero <= 0) {
            throw erro(400, 'Número da amostra deve ser numérico.');
        }
        where.push('a.numero_amostra = ?');
        params.push(numero);
    }

    if (texto(filtros.tipo_amostra)) {
        where.push('a.tipo_amostra = ?');
        params.push(validarTipo(filtros.tipo_amostra));
    }

    return {
        whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
        params
    };
}

async function consultarAmostras(filtros = {}, cpfObrigatorio = null, incluirLaudo = true) {
    const { whereSql, params } = montarFiltrosAmostras(filtros, cpfObrigatorio);
    const campoLaudo = incluirLaudo ? 'a.laudo,' : '';
    return all(
        `SELECT
            a.id,
            a.pedido_id,
            a.numero_amostra,
            a.identificacao_amostra,
            a.tipo_amostra,
            a.status,
            ${campoLaudo}
            a.data_cadastro,
            a.data_entrega,
            p.numero_pedido,
            p.cpf_cliente,
            p.nome_cliente
         FROM amostras a
         JOIN pedidos p ON p.id = a.pedido_id
         ${whereSql}
         ORDER BY p.data_cadastro DESC, p.id DESC, a.tipo_amostra ASC, a.numero_amostra ASC`,
        params
    );
}

async function migrarFuncionarios() {
    await run(`CREATE TABLE IF NOT EXISTS funcionarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL,
        senha_hash TEXT,
        email TEXT,
        telefone TEXT,
        data_cadastro TEXT
    )`);

    await adicionarColunaSeNaoExiste('funcionarios', 'senha_hash', 'TEXT');
    await adicionarColunaSeNaoExiste('funcionarios', 'email', 'TEXT');
    await adicionarColunaSeNaoExiste('funcionarios', 'telefone', 'TEXT');
    await adicionarColunaSeNaoExiste('funcionarios', 'data_cadastro', 'TEXT');

    const total = await get('SELECT COUNT(*) AS total FROM funcionarios');
    if (!total.total) {
        const hash = await bcrypt.hash('PA1406', 10);
        await run(
            `INSERT INTO funcionarios (codigo, nome, senha_hash, data_cadastro)
             VALUES (?, ?, ?, ?)`,
            ['PA1406', 'Funcionário Teste', hash, dataAgora()]
        );
        return;
    }

    const semSenha = await all(
        `SELECT id
         FROM funcionarios
         WHERE senha_hash IS NULL OR senha_hash = ''`
    );
    if (semSenha.length) {
        const hash = await bcrypt.hash('PA1406', 10);
        for (const funcionario of semSenha) {
            await run(
                `UPDATE funcionarios
                 SET senha_hash = ?, data_cadastro = COALESCE(data_cadastro, ?)
                 WHERE id = ?`,
                [hash, dataAgora(), funcionario.id]
            );
        }
    }
}

async function migrarAmostras() {
    const existe = await tabelaExiste('amostras');
    if (!existe) {
        await criarTabelaAmostras();
        return;
    }

    const colunas = await colunasTabela('amostras');
    const finalizada = ['pedido_id', 'numero_amostra', 'identificacao_amostra', 'tipo_amostra', 'status', 'laudo']
        .every((coluna) => colunas.includes(coluna));

    if (finalizada) return;

    const backup = `amostras_legado_${Date.now()}`;
    await withTransaction(async () => {
        await run(`ALTER TABLE amostras RENAME TO ${backup}`);
        await criarTabelaAmostras();

        const legadas = await all(
            `SELECT a.id, a.cliente_id, a.data_recebimento, a.observacoes, c.cpf, c.nome
             FROM ${backup} a
             LEFT JOIN clientes c ON c.id = a.cliente_id
             ORDER BY a.id ASC`
        );

        for (const legada of legadas) {
            const cpfNormalizado = normalizarCpf(legada.cpf);
            const cpf = cpfNormalizado || `LEGADO-${legada.cliente_id || legada.id}`;
            const nome = texto(legada.nome) || `Cliente legado ${legada.cliente_id || legada.id}`;

            await upsertCliente(cpf, nome);
            const pedido = await criarPedidoNoBanco({ cpf, nome });
            await adicionarAmostraNoBanco(pedido.id, {
                identificacao_amostra: `Amostra antiga ${legada.id}`,
                tipo_amostra: 'Solo',
                laudo: texto(legada.observacoes)
            });
        }
    });
}

async function inicializarBanco() {
    await run('PRAGMA foreign_keys = OFF');

    await run(`CREATE TABLE IF NOT EXISTS clientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cpf TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL,
        endereco TEXT,
        telefone TEXT,
        email TEXT,
        nome_fazenda TEXT
    )`);

    await adicionarColunaSeNaoExiste('clientes', 'telefone', 'TEXT');
    await adicionarColunaSeNaoExiste('clientes', 'email', 'TEXT');
    await adicionarColunaSeNaoExiste('clientes', 'nome_fazenda', 'TEXT');

    await migrarFuncionarios();

    await run(`CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        numero_pedido TEXT NOT NULL UNIQUE,
        ano INTEGER NOT NULL,
        cpf_cliente TEXT NOT NULL,
        nome_cliente TEXT NOT NULL,
        data_cadastro TEXT NOT NULL
    )`);

    await migrarAmostras();

    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_numero ON pedidos(numero_pedido)');
    await run('CREATE INDEX IF NOT EXISTS idx_pedidos_cpf ON pedidos(cpf_cliente)');
    await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_amostras_tipo_numero ON amostras(tipo_amostra, numero_amostra)');
    await run('CREATE INDEX IF NOT EXISTS idx_amostras_pedido ON amostras(pedido_id)');
    await run('CREATE INDEX IF NOT EXISTS idx_amostras_cpf ON amostras(cpf_cliente)');

    await run('PRAGMA foreign_keys = ON');
}

function verificarToken(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!token) return res.status(403).json({ sucesso: false, mensagem: 'Acesso negado.' });

    jwt.verify(token, SECRET_KEY, (err, decodificado) => {
        if (err) return res.status(401).json({ sucesso: false, mensagem: 'Sessão expirada.' });
        req.usuario = decodificado;
        next();
    });
}

function exigirFuncionario(req, res, next) {
    if (req.usuario?.tipo !== 'funcionario') {
        return res.status(403).json({ sucesso: false, mensagem: 'Acesso restrito ao funcionário.' });
    }
    next();
}

function exigirCliente(req, res, next) {
    if (req.usuario?.tipo !== 'cliente') {
        return res.status(403).json({ sucesso: false, mensagem: 'Acesso restrito ao cliente.' });
    }
    next();
}

function validarCpfCliente(req) {
    const cpfToken = req.usuario.cpf;
    const cpfFiltro = normalizarCpf(req.query.cpf || req.body.cpf || cpfToken);
    if (cpfFiltro && cpfFiltro !== cpfToken) {
        throw erro(403, 'Cliente não pode acessar dados de outro CPF.');
    }
    return cpfToken;
}

app.get('/api/opcoes', (req, res) => {
    res.json({
        tipos_amostra: TIPOS_AMOSTRA,
        status_amostra: STATUS_AMOSTRA,
        status_funcionario: STATUS_FUNCIONARIO
    });
});

app.get('/api/clientes', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const termo = texto(req.query.termo);
    const documento = normalizarDocumento(req.query.cpf || req.query.documento);
    const where = [];
    const params = [];

    if (documento) {
        where.push('cpf LIKE ?');
        params.push(`%${documento}%`);
    }

    if (termo) {
        where.push(`(
            nome LIKE ?
            OR cpf LIKE ?
            OR email LIKE ?
            OR telefone LIKE ?
            OR nome_fazenda LIKE ?
        )`);
        params.push(...Array(5).fill(`%${termo}%`));
    }

    const clientes = await all(
        `SELECT id, cpf, nome, endereco, telefone, email, nome_fazenda
         FROM clientes
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY nome COLLATE NOCASE ASC`,
        params
    );
    res.json(clientes);
}));

app.post('/api/clientes', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const nome = texto(req.body.nome);
    const cpf = normalizarDocumento(req.body.cpf || req.body.documento);
    if (!nome) throw erro(400, 'Nome do cliente é obrigatório.');
    if (!cpf) throw erro(400, 'CPF ou CNPJ é obrigatório.');

    const existente = await get('SELECT id FROM clientes WHERE cpf = ?', [cpf]);
    if (existente) throw erro(400, 'Já existe cliente com este CPF ou CNPJ.');

    const result = await run(
        `INSERT INTO clientes (cpf, nome, endereco, telefone, email, nome_fazenda)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            cpf,
            nome,
            texto(req.body.endereco),
            texto(req.body.telefone),
            texto(req.body.email),
            texto(req.body.nome_fazenda)
        ]
    );

    res.status(201).json({
        sucesso: true,
        mensagem: 'Cliente cadastrado com sucesso.',
        cliente: {
            id: result.lastID,
            cpf,
            nome,
            endereco: texto(req.body.endereco),
            telefone: texto(req.body.telefone),
            email: texto(req.body.email),
            nome_fazenda: texto(req.body.nome_fazenda)
        }
    });
}));

app.put('/api/clientes/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const clienteAtual = await get('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
    if (!clienteAtual) throw erro(404, 'Cliente não encontrado.');

    const nome = texto(req.body.nome);
    const cpf = normalizarDocumento(req.body.cpf || req.body.documento);
    if (!nome) throw erro(400, 'Nome do cliente é obrigatório.');
    if (!cpf) throw erro(400, 'CPF ou CNPJ é obrigatório.');

    const existente = await get('SELECT id FROM clientes WHERE cpf = ? AND id <> ?', [cpf, clienteAtual.id]);
    if (existente) throw erro(400, 'Já existe outro cliente com este CPF ou CNPJ.');

    await withTransaction(async () => {
        await run(
            `UPDATE clientes
             SET cpf = ?, nome = ?, endereco = ?, telefone = ?, email = ?, nome_fazenda = ?
             WHERE id = ?`,
            [
                cpf,
                nome,
                texto(req.body.endereco),
                texto(req.body.telefone),
                texto(req.body.email),
                texto(req.body.nome_fazenda),
                clienteAtual.id
            ]
        );

        await run(
            `UPDATE pedidos
             SET cpf_cliente = ?, nome_cliente = ?
             WHERE cpf_cliente = ?`,
            [cpf, nome, clienteAtual.cpf]
        );

        await run(
            `UPDATE amostras
             SET cpf_cliente = ?, nome_cliente = ?
             WHERE cpf_cliente = ?`,
            [cpf, nome, clienteAtual.cpf]
        );
    });

    res.json({
        sucesso: true,
        mensagem: 'Cliente atualizado com sucesso.',
        cliente: await get('SELECT id, cpf, nome, endereco, telefone, email, nome_fazenda FROM clientes WHERE id = ?', [clienteAtual.id])
    });
}));

app.delete('/api/clientes/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const cliente = await get('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
    if (!cliente) throw erro(404, 'Cliente não encontrado.');

    await withTransaction(async () => {
        const colunasPedidos = await colunasTabela('pedidos');
        const colunasAmostras = await colunasTabela('amostras');
        const pedidosCliente = [];

        if (colunasPedidos.includes('cpf_cliente')) {
            pedidosCliente.push(...await all('SELECT id FROM pedidos WHERE cpf_cliente = ?', [cliente.cpf]));
        }

        if (colunasPedidos.includes('cliente_id')) {
            pedidosCliente.push(...await all('SELECT id FROM pedidos WHERE cliente_id = ?', [cliente.id]));
        }

        const pedidoIds = [...new Set(pedidosCliente.map((pedido) => pedido.id))];
        if (pedidoIds.length && colunasAmostras.includes('pedido_id')) {
            const placeholders = pedidoIds.map(() => '?').join(', ');
            await run(`DELETE FROM amostras WHERE pedido_id IN (${placeholders})`, pedidoIds);
        }

        if (colunasAmostras.includes('cpf_cliente')) {
            await run('DELETE FROM amostras WHERE cpf_cliente = ?', [cliente.cpf]);
        }

        if (colunasAmostras.includes('cliente_id')) {
            await run('DELETE FROM amostras WHERE cliente_id = ?', [cliente.id]);
        }

        if (colunasPedidos.includes('cpf_cliente')) {
            await run('DELETE FROM pedidos WHERE cpf_cliente = ?', [cliente.cpf]);
        }

        if (colunasPedidos.includes('cliente_id')) {
            await run('DELETE FROM pedidos WHERE cliente_id = ?', [cliente.id]);
        }

        await run('DELETE FROM clientes WHERE id = ?', [cliente.id]);
    });

    res.json({ sucesso: true, mensagem: 'Cliente apagado com sucesso.' });
}));

app.post('/api/funcionarios', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const nome = texto(req.body.nome);
    const senha = texto(req.body.senha);
    if (!nome) throw erro(400, 'Nome do funcionário é obrigatório.');
    if (!senha) throw erro(400, 'Senha do funcionário é obrigatória.');

    const hash = await bcrypt.hash(senha, 10);
    const result = await run(
        `INSERT INTO funcionarios (codigo, nome, senha_hash, email, telefone, data_cadastro)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [codigoFuncionario(), nome, hash, texto(req.body.email), texto(req.body.telefone), dataAgora()]
    );

    res.status(201).json({
        sucesso: true,
        mensagem: 'Funcionário cadastrado com sucesso.',
        funcionario: {
            id: result.lastID,
            nome,
            email: texto(req.body.email),
            telefone: texto(req.body.telefone)
        }
    });
}));

app.get('/api/funcionarios', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const termo = texto(req.query.termo);
    const where = [];
    const params = [];

    if (termo) {
        where.push(`(
            nome LIKE ?
            OR email LIKE ?
            OR telefone LIKE ?
        )`);
        params.push(...Array(3).fill(`%${termo}%`));
    }

    const funcionarios = await all(
        `SELECT id, nome, email, telefone, data_cadastro
         FROM funcionarios
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY nome COLLATE NOCASE ASC`
        ,
        params
    );
    res.json(funcionarios);
}));

app.put('/api/funcionarios/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const funcionario = await get('SELECT * FROM funcionarios WHERE id = ?', [req.params.id]);
    if (!funcionario) throw erro(404, 'Funcionário não encontrado.');

    const nome = texto(req.body.nome);
    const senha = texto(req.body.senha);
    if (!nome) throw erro(400, 'Nome do funcionário é obrigatório.');

    const senhaSql = senha ? ', senha_hash = ?' : '';
    const params = [
        nome,
        texto(req.body.email),
        texto(req.body.telefone)
    ];
    if (senha) params.push(await bcrypt.hash(senha, 10));
    params.push(funcionario.id);

    await run(
        `UPDATE funcionarios
         SET nome = ?, email = ?, telefone = ?${senhaSql}
         WHERE id = ?`,
        params
    );

    res.json({
        sucesso: true,
        mensagem: 'Funcionário atualizado com sucesso.',
        funcionario: await get('SELECT id, nome, email, telefone, data_cadastro FROM funcionarios WHERE id = ?', [funcionario.id])
    });
}));

app.delete('/api/funcionarios/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const funcionario = await get('SELECT * FROM funcionarios WHERE id = ?', [req.params.id]);
    if (!funcionario) throw erro(404, 'Funcionário não encontrado.');

    const total = await get('SELECT COUNT(*) AS total FROM funcionarios');
    if (Number(total.total) <= 1) {
        throw erro(400, 'Não é possível apagar o único funcionário cadastrado.');
    }

    await run('DELETE FROM funcionarios WHERE id = ?', [funcionario.id]);
    res.json({ sucesso: true, mensagem: 'Funcionário apagado com sucesso.' });
}));

app.post('/api/login/funcionario', asyncRoute(async (req, res) => {
    const nome = texto(req.body.nome);
    const senha = texto(req.body.senha);
    if (!nome || !senha) throw erro(400, 'Informe nome e senha do funcionário.');

    const nomeNormalizado = normalizarNome(nome);
    const funcionarios = await all('SELECT id, nome, senha_hash FROM funcionarios');

    for (const funcionario of funcionarios) {
        const mesmoNome = normalizarNome(funcionario.nome) === nomeNormalizado;
        if (mesmoNome && funcionario.senha_hash && await bcrypt.compare(senha, funcionario.senha_hash)) {
            const token = jwt.sign(
                { id: funcionario.id, tipo: 'funcionario', nome: funcionario.nome },
                SECRET_KEY,
                { expiresIn: '8h' }
            );
            return res.json({ sucesso: true, token, nome: funcionario.nome });
        }
    }

    throw erro(401, 'Nome ou senha de funcionário inválidos.');
}));

app.post('/api/login/cliente', asyncRoute(async (req, res) => {
    const cpf = normalizarCpf(req.body.cpf);
    if (!cpf) throw erro(400, 'CPF é obrigatório.');

    let cliente = await get('SELECT cpf, nome FROM clientes WHERE cpf = ?', [cpf]);
    if (!cliente) {
        throw erro(401, 'CPF não encontrado. Verifique se o laboratório já realizou seu cadastro.');
    }

    const token = jwt.sign(
        { cpf: cliente.cpf, tipo: 'cliente', nome: cliente.nome },
        SECRET_KEY,
        { expiresIn: '2h' }
    );
    res.json({ sucesso: true, token, nome: cliente.nome, cpf: cliente.cpf });
}));

app.post('/api/pedidos', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const cpf = normalizarCpf(req.body.cpf_cliente || req.body.cpf);
    const nome = texto(req.body.nome_cliente || req.body.nome);
    if (!cpf) throw erro(400, 'CPF do cliente é obrigatório.');
    if (!nome) throw erro(400, 'Nome do cliente é obrigatório.');

    const pedido = await withTransaction(async () => {
        await upsertCliente(cpf, nome, texto(req.body.endereco));
        return criarPedidoNoBanco({ cpf, nome });
    });

    res.status(201).json({
        sucesso: true,
        mensagem: `Pedido ${pedido.numero_pedido} cadastrado com sucesso.`,
        pedido
    });
}));

app.get('/api/pedidos', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const pedidos = await consultarPedidos(req.query);
    res.json(pedidos);
}));

app.get('/api/pedidos/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const detalhe = await consultarPedidoDetalhado(req.params.id, null, true);
    res.json(detalhe);
}));

app.delete('/api/pedidos/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const pedido = await get('SELECT * FROM pedidos WHERE id = ?', [req.params.id]);
    if (!pedido) throw erro(404, 'Pedido não encontrado.');

    await withTransaction(async () => {
        await run('DELETE FROM amostras WHERE pedido_id = ?', [pedido.id]);
        await run('DELETE FROM pedidos WHERE id = ?', [pedido.id]);
    });

    res.json({ sucesso: true, mensagem: 'Pedido apagado com sucesso.' });
}));

app.post('/api/pedidos/:id/amostras', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const amostra = await withTransaction(() => adicionarAmostraNoBanco(req.params.id, req.body));
    res.status(201).json({
        sucesso: true,
        mensagem: `Amostra ${amostra.numero_amostra} (${amostra.tipo_amostra}) cadastrada com sucesso.`,
        amostra
    });
}));

app.put('/api/amostras/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const amostraAtual = await getAmostraCompleta(req.params.id);
    if (!amostraAtual) throw erro(404, 'Amostra não encontrada.');

    const identificacao = texto(req.body.identificacao_amostra);
    if (!identificacao) throw erro(400, 'Identificação da amostra é obrigatória.');

    const novoTipo = validarTipo(req.body.tipo_amostra);
    const novoStatus = validarStatus(req.body.status, STATUS_FUNCIONARIO);
    const laudo = texto(req.body.laudo);

    const atualizada = await withTransaction(async () => {
        let numeroAmostra = amostraAtual.numero_amostra;

        if (novoTipo !== amostraAtual.tipo_amostra) {
            const ultimo = await get(
                `SELECT MAX(numero_amostra) AS numero
                 FROM amostras
                 WHERE tipo_amostra = ?`,
                [novoTipo]
            );
            numeroAmostra = Number(ultimo?.numero || 0) + 1;
        }

        await run(
            `UPDATE amostras
             SET numero_amostra = ?,
                 identificacao_amostra = ?,
                 tipo_amostra = ?,
                 status = ?,
                 laudo = ?,
                 data_entrega = CASE WHEN ? = 'Entregue' THEN data_entrega ELSE NULL END
             WHERE id = ?`,
            [numeroAmostra, identificacao, novoTipo, novoStatus, laudo, novoStatus, amostraAtual.id]
        );

        return getAmostraCompleta(amostraAtual.id);
    });

    res.json({
        sucesso: true,
        mensagem: 'Amostra atualizada com sucesso.',
        amostra: atualizada
    });
}));

app.delete('/api/amostras/:id', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const amostra = await getAmostraCompleta(req.params.id);
    if (!amostra) throw erro(404, 'Amostra não encontrada.');

    await run('DELETE FROM amostras WHERE id = ?', [amostra.id]);
    res.json({ sucesso: true, mensagem: 'Amostra apagada com sucesso.' });
}));

app.get('/api/laudos', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const amostras = await consultarAmostras(req.query, null, true);
    res.json(amostras);
}));

app.put('/api/amostras/:id/laudo', verificarToken, exigirFuncionario, asyncRoute(async (req, res) => {
    const amostra = await getAmostraCompleta(req.params.id);
    if (!amostra) throw erro(404, 'Amostra não encontrada.');

    await run('UPDATE amostras SET laudo = ? WHERE id = ?', [texto(req.body.laudo), amostra.id]);
    res.json({
        sucesso: true,
        mensagem: 'Laudo atualizado com sucesso.',
        amostra: await getAmostraCompleta(amostra.id)
    });
}));

app.get('/api/cliente/pedidos', verificarToken, exigirCliente, asyncRoute(async (req, res) => {
    const cpf = validarCpfCliente(req);
    const pedidos = await consultarPedidos(req.query, cpf);
    res.json(pedidos);
}));

app.get('/api/cliente/pedidos/:id', verificarToken, exigirCliente, asyncRoute(async (req, res) => {
    const cpf = validarCpfCliente(req);
    const detalhe = await consultarPedidoDetalhado(req.params.id, cpf, false);
    res.json(detalhe);
}));

app.get('/api/cliente/laudos', verificarToken, exigirCliente, asyncRoute(async (req, res) => {
    const cpf = validarCpfCliente(req);
    const amostras = await consultarAmostras(req.query, cpf, false);
    res.json(amostras);
}));

app.get('/api/cliente/amostras/:id/laudo', verificarToken, exigirCliente, asyncRoute(async (req, res) => {
    const cpf = validarCpfCliente(req);
    const amostra = await get(
        `SELECT
            a.id,
            a.pedido_id,
            a.numero_amostra,
            a.identificacao_amostra,
            a.tipo_amostra,
            a.status,
            a.laudo,
            a.data_entrega,
            p.numero_pedido,
            p.cpf_cliente,
            p.nome_cliente
         FROM amostras a
         JOIN pedidos p ON p.id = a.pedido_id
         WHERE a.id = ? AND a.cpf_cliente = ?`,
        [req.params.id, cpf]
    );

    if (!amostra) throw erro(404, 'Laudo não encontrado para este CPF.');

    if (amostra.status !== 'Entregue') {
        await run(
            `UPDATE amostras
             SET status = 'Entregue', data_entrega = ?
             WHERE id = ?`,
            [dataAgora(), amostra.id]
        );
    }

    const atualizada = await getAmostraCompleta(amostra.id);
    res.json({
        sucesso: true,
        laudo: atualizada.laudo || '',
        amostra: atualizada
    });
}));

app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({
        sucesso: false,
        mensagem: err.status ? err.message : 'Erro interno do servidor.'
    });
});

inicializarBanco()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Servidor rodando em http://localhost:${PORT}`);
        });
    })
    .catch((err) => {
        console.error('Erro ao inicializar o banco:', err);
        process.exit(1);
    });
