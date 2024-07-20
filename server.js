const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const dbPath = path.resolve(__dirname, 'mydatabase.db');

// Cria um novo banco de dados ou abre o existente
const db = new sqlite3.Database(dbPath);

// Configurações de middleware
app.use(cors()); // Adiciona o middleware CORS
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Inicializa o banco de dados
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT)");
  db.run(`
    CREATE TABLE IF NOT EXISTS tests (
      id INTEGER PRIMARY KEY,
      case_id INTEGER,
      user_id INTEGER,
      timestamp TEXT,
      approved INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Verifica se a coluna 'approved' existe antes de tentar adicioná-la
  db.all("PRAGMA table_info(tests)", (err, rows) => {
    if (err) {
      console.error(err.message);
      return;
    }
    const columnExists = Array.isArray(rows) && rows.some(row => row.name === 'approved');
    if (!columnExists) {
      db.run("ALTER TABLE tests ADD COLUMN approved INTEGER", (err) => {
        if (err) {
          console.error(err.message);
        }
      });
    }
  });
});

// Endpoint para obter usuários
app.get('/users', (req, res) => {
  db.all("SELECT * FROM users", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ users: rows });
  });
});

// Endpoint para adicionar usuário
app.post('/users', (req, res) => {
  const { username } = req.body;
  db.run("INSERT INTO users (username) VALUES (?)", [username], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ id: this.lastID });
  });
});

// Endpoint para registrar um novo teste
app.post('/tests', (req, res) => {
  const { case_id, user_id, developer_name } = req.body;
  const timestamp = new Date().toISOString(); // Gera um timestamp com data e hora
  const approved = null; // Inicialmente nulo

  db.run("INSERT INTO tests (case_id, user_id, developer_name, timestamp, approved) VALUES (?, ?, ?, ?, ?)", 
      [case_id, user_id, developer_name, timestamp, approved], function(err) {
      if (err) {
          return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID });
  });
});

// Endpoint para atualizar o status de aprovação de um teste
app.patch('/tests/:id', (req, res) => {
  const { id } = req.params;
  const { approved } = req.body;
  db.run("UPDATE tests SET approved = ? WHERE id = ?", [approved, id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: 'Teste atualizado com sucesso', id });
  });
});

// Endpoint para obter todos os testes relacionados a um caso específico, incluindo o nome do usuário e do desenvolvedor
app.get('/tests', (req, res) => {
  const { case_id } = req.query;
  const query = `
    SELECT tests.id, tests.case_id, tests.user_id, tests.timestamp, tests.approved, tests.developer_name, users.username
    FROM tests
    JOIN users ON tests.user_id = users.id
    WHERE tests.case_id = ?
  `;
  db.all(query, [case_id], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ tests: rows });
  });
});

// Endpoint para excluir um teste
app.delete('/tests/:id', (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM tests WHERE id = ?", [id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ message: 'Teste excluído com sucesso', id });
  });
});

// Endpoint para obter a quantidade de testes por período
app.get('/tests/count/by-period', (req, res) => {
  const { start_date, end_date } = req.query;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  const query = `
      SELECT COUNT(*) as count
      FROM tests
      WHERE timestamp BETWEEN ? AND ?
  `;
  db.get(query, [startDateTime, endDateTime], (err, row) => {
      if (err) {
          return res.status(500).json({ error: err.message });
      }
      res.json({ count: row.count });
  });
});


// Endpoint para obter a contagem de testes por caso, incluindo o nome do desenvolvedor e status de aprovação, com filtro por datas
app.get('/tests/count/by-case', (req, res) => {
  const { start_date, end_date } = req.query;
  console.log(`Received request with start_date: ${start_date} and end_date: ${end_date}`);

  // Formatar datas para garantir a compatibilidade com a consulta SQL
  const formattedStartDate = `${start_date}T00:00:00.000Z`;
  const formattedEndDate = `${end_date}T23:59:59.999Z`;

  const query = `
    SELECT tests.case_id, tests.developer_name,
           SUM(CASE WHEN tests.approved = 1 THEN 1 ELSE 0 END) as approved_count,
           SUM(CASE WHEN tests.approved = 0 THEN 1 ELSE 0 END) as rejected_count,
           SUM(CASE WHEN tests.approved IS NULL THEN 1 ELSE 0 END) as undefined_count
    FROM tests
    WHERE tests.timestamp BETWEEN ? AND ?
    GROUP BY tests.case_id, tests.developer_name
  `;

  db.all(query, [formattedStartDate, formattedEndDate], (err, rows) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('Query result:', rows);
    res.json({ counts: rows });
  });
});




// Endpoint para obter a contagem de testes por status de aprovação e top 10 desenvolvedores
app.get('/tests/count/by-approval', (req, res) => {
  const query = `
    SELECT
      SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN approved IS NULL THEN 1 ELSE 0 END) as undefined,
      (SELECT GROUP_CONCAT(name || ' (' || count || ')', ', ') FROM (
        SELECT developer_name as name, COUNT(*) as count
        FROM tests
        WHERE approved = 1
        GROUP BY developer_name
        ORDER BY count DESC
        LIMIT 10
      )) as top_approved_developers,
      (SELECT GROUP_CONCAT(name || ' (' || count || ')', ', ') FROM (
        SELECT developer_name as name, COUNT(*) as count
        FROM tests
        WHERE approved = 0
        GROUP BY developer_name
        ORDER BY count DESC
        LIMIT 10
      )) as top_rejected_developers
    FROM tests
  `;

  db.get(query, (err, row) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    console.log('Query result:', row);
    res.json(row);
  });
});

// Endpoint para servir o arquivo HTML do dashboard
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Endpoint para obter a quantidade de testes realizados pelos usuários por período (semana, quinzena, mês, hoje)
app.get('/tests/count/by-user/:period', (req, res) => {
  const period = req.params.period;
  let query;

  if (period === 'weekly') {
      query = `
          SELECT date(timestamp) as date, users.username, COUNT(*) as count
          FROM tests
          JOIN users ON tests.user_id = users.id
          WHERE timestamp >= datetime('now', '-7 days')
          GROUP BY date(timestamp), users.username
      `;
  } else if (period === 'fortnightly') {
      query = `
          SELECT date(timestamp) as date, users.username, COUNT(*) as count
          FROM tests
          JOIN users ON tests.user_id = users.id
          WHERE timestamp >= datetime('now', '-15 days')
          GROUP BY date(timestamp), users.username
      `;
  } else if (period === 'monthly') {
      query = `
          SELECT date(timestamp) as date, users.username, COUNT(*) as count
          FROM tests
          JOIN users ON tests.user_id = users.id
          WHERE timestamp >= datetime('now', '-30 days')
          GROUP BY date(timestamp), users.username
      `;
  } else if (period === 'today') {
      query = `
          SELECT date(timestamp) as date, users.username, COUNT(*) as count
          FROM tests
          JOIN users ON tests.user_id = users.id
          WHERE date(timestamp) = date('now')
          GROUP BY date(timestamp), users.username
      `;
  } else {
      return res.status(400).json({ error: 'Invalid period' });
  }

  db.all(query, [], (err, rows) => {
      if (err) {
          return res.status(500).json({ error: err.message });
      }
      res.json({ counts: rows });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
