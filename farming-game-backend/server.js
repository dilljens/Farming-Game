const express = require('express');
const cors = require('cors');

// Create an Express application
const app = express();
// start server with npm run start or npm run dev

// Use CORS to allow requests from your frontend domain
app.use(cors());

// Define a simple route for testing
app.get('/', (req, res) => {
    res.send('Hello, Farming Game Backend!');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necessary if your database uses SSL
  }
});

app.get('https://farming-game-db.fly.dev/leaderboard', async (req, res) => {
 try {
     const result = await pool.query('SELECT username, networth FROM yourActualLeaderboardTable ORDER BY networth DESC');
     res.json(result.rows);
 } catch (err) {
     console.error(err);
     res.status(500).send('Error fetching leaderboard data');
 }
});

