const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'farmdb',
    password: 'raspi',
    port: 5432
});

app.get('/api/databases', async (req, res) => {
    try {
        const result = await pool.query('SELECT datname FROM pg_database WHERE datistemplate = false;');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching databases');
    }
});

pool.query('SELECT * FROM leaderboard', (err, res) => {
    if (err) {
        throw err;
    }
    console.log(res.rows);
    // process the results
});

// Rest of your server code...
