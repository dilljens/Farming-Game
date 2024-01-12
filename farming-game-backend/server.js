
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

console.log('DATABASE_URL:', process.env.DATABASE_URL);

const app = express();

app.use(cors());

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.post('/api/addUser', async (req, res) => {
  const { username, networth } = req.body;
  try {
    await pool.query('INSERT INTO leaderboard (username, networth) VALUES ($1, $2)', [username, networth]);
    res.status(200).json({ message: 'User added successfully' });
  } catch (err) {
    console.error("Database insert error: ", err);
    res.status(500).send('Error adding user to leaderboard: ' + err.message);
  }
});


app.get('/api/leaderboard', async (req, res) => {
    try {
        // console.log('hi');
        const result = await pool.query('SELECT username, networth FROM leaderboard ORDER BY networth DESC');
        res.json(result.rows);
        console.log('leaderboard',result.rows);
    } catch (err) {
      console.error("Database query error: ", err);
      res.status(500).send('Error fetching leaderboard data: ' + err.message);
  }
  
});

app.get('/', (req, res) => {
    res.send('Hello, Farming Game Backend!');
});
