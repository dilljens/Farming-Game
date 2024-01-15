
require('dotenv').config();

const express = require('express');

const cors = require('cors');
const { Pool } = require('pg');

console.log('DATABASE_URL:', process.env.DATABASE_URL);

const app = express();
app.use(express.json());

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
    const query = `
      INSERT INTO leaderboard (username, networth) 
      VALUES ($1, $2) 
      ON CONFLICT (username) DO UPDATE 
      SET networth = EXCLUDED.networth;
    `;
    await pool.query(query, [username, networth]);
    res.status(200).json({ message: 'User added or updated successfully' });
  } catch (err) {
    console.error("Database insert/update error: ", err);
    res.status(500).send('Error adding/updating user in leaderboard: ' + err.message);
  }
});

app.post('/api/resetLeaderboard', async (req, res) => {
  try {
      await pool.query('TRUNCATE TABLE leaderboard');
      res.status(200).json({ message: 'Leaderboard reset successfully' });
  } catch (err) {
      console.error("Database reset error: ", err);
      res.status(500).json({ message: 'Error resetting leaderboard: ' + err.message });
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
