# Backend Options for Farming Game Leaderboard

This document outlines two viable backend options for hosting the leaderboard functionality in the Farming Game: Fly.io and Firebase. Both support real-time updates for multiple players, but they differ in setup complexity, cost, and maintenance.

## Option 1: Fly.io (Hosted Server + Postgres)

### Overview
- **Type**: Self-hosted backend using Node.js, Express, WebSocket, and Postgres database.
- **Hosting**: Deployed on Fly.io (a platform for running apps globally).
- **Real-time**: WebSocket broadcasts leaderboard updates to all connected clients.
- **Persistence**: Data stored in Postgres (SQL database).

### Pros
- Full control over server logic (e.g., custom validation, rate limiting).
- SQL database for complex queries if needed.
- Scales well for moderate traffic.
- Integrates with existing Node.js backend code.

### Cons
- Requires deployment and maintenance (e.g., keeping the app running, handling cold starts).
- Needs a Postgres database (Fly Postgres or external).
- More complex setup: Docker, environment variables, database schema.
- Not "serverless"—you pay for uptime.

### Setup Steps
1. Create a Fly account and install Fly CLI.
2. Deploy the backend: `fly deploy` from `farming-game-backend/`.
3. Attach Postgres: `fly postgres create` and `fly postgres attach`.
4. Set environment variables (e.g., `DATABASE_URL`).
5. Ensure CORS allows your frontend (e.g., GitHub Pages URL).
6. Frontend automatically uses Fly URLs when not on localhost.

### Cost
- Free tier available, but for persistent uptime/WebSockets, expect ~$5-10/month for 1 machine.
- Postgres adds ~$5-10/month.

### When to Use
- If you prefer SQL and full server control.
- For educational purposes or if you want to learn deployment.

## Option 2: Firebase (Firestore + Real-time)

### Overview
- **Type**: Serverless database with real-time listeners.
- **Hosting**: No backend server needed; frontend connects directly to Firestore.
- **Real-time**: `onSnapshot()` provides live updates (replaces WebSocket).
- **Persistence**: NoSQL document database (Firestore).

### Pros
- No server to deploy or maintain.
- Extremely simple setup: just add Firebase SDK to frontend.
- Real-time out of the box.
- Free tier sufficient for small-scale use (e.g., <6 players).
- Good for rapid prototyping.

### Cons
- Less control over logic (all in client-side code).
- NoSQL can be less familiar if you're used to SQL.
- Requires security rules to prevent abuse (e.g., spam writes).
- Vendor lock-in to Google/Firebase.

### Setup Steps
1. Create a Firebase project at console.firebase.google.com.
2. Enable Firestore and Authentication (anonymous auth recommended).
3. Add Firebase SDK to your frontend (via CDN or npm).
4. Set Firestore security rules (e.g., allow reads/writes only for authenticated users).
5. Replace backend API calls in [scripts.js](scripts.js) with Firestore operations:
   - Upsert scores: `setDoc(doc(db, 'leaderboard', username), { networth, updatedAt })`
   - Read leaderboard: `query(collection(db, 'leaderboard'), orderBy('networth', 'desc'), limit(10))`
   - Listen for updates: `onSnapshot(query, (snapshot) => updateLeaderboardTable(snapshot.docs.map(doc => doc.data())))`

### Cost
- Free tier (Spark plan): 1GB storage, 50K reads/day, 20K writes/day—plenty for <6 players.
- Blaze plan (pay-as-you-go) if you exceed limits.

### When to Use
- If you want the simplest possible setup with no server management.
- For quick demos or small groups.

## Recommendation
- **For simplicity and low maintenance**: Go with Firebase. It's ideal for your scale and eliminates server ops.
- **For learning/full control**: Use Fly.io if you want to experiment with deployment and databases.

Both options support multiple players seeing each other's scores in real-time. If you choose Firebase, I can help migrate the frontend code. For Fly, focus on ensuring the database is set up correctly.