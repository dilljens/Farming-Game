const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
const corsOptions = {
  origin: 'http://127.0.0.1:3000',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(cors());

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'farmdb',
    password: 'raspi',
    port: 5432
});

// Create an HTTP server with the Express app
const server = http.createServer(app);

// Attach WebSocket server to the HTTP server
const wss = new WebSocket.Server({ server });



// Broadcast to all clients
function broadcast(data) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
        }
    });
}

// Fetch and broadcast leaderboard data
async function updateAndBroadcastLeaderboard() {
  try {
    const result = await pool.query('SELECT username, networth FROM leaderboard ORDER BY networth DESC');
        broadcast(result.rows);
      } catch (err) {
        console.error("Error broadcasting leaderboard data: ", err);
    }
}

wss.on('connection', ws => {
  ws.on('message', message => {
    console.log('Received message:', message);
    // Handle incoming messages if needed
  });
  
  // Send current leaderboard data to newly connected client
  updateAndBroadcastLeaderboard();
});


// Modify your /api/addUser route to broadcast updates
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
    
    // Broadcast updated leaderboard
      await updateAndBroadcastLeaderboard();
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

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
