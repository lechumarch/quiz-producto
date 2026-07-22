import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { migrate } from './db';
import { basicAuth } from './middleware/auth';
import adminRouter from './routes/admin';
import playerRouter from './routes/player';
import { registerClient, handlePlayerJoin, handlePlayerAnswer, initEventPolling } from './game/engine';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Strip /quiz-producto prefix when present (Tailscale path-mount or Ownia proxy)
app.use((req, _res, next) => {
  const prefix = '/quiz-producto';
  if (req.url.startsWith(prefix)) {
    req.url = req.url.slice(prefix.length) || '/';
  }
  next();
});

app.use(express.json({ limit: '500kb' }));

app.get('/host', basicAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/host/index.html')));
app.get('/host/lobby', basicAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/host/lobby.html')));
app.get('/host/refine', basicAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/host/refine.html')));
app.get('/host/game', basicAuth, (_req, res) => res.sendFile(path.join(__dirname, '../public/host/game.html')));

app.use(express.static(path.join(__dirname, '../public')));

app.use('/host', adminRouter);
app.use(playerRouter);

app.get('/join', (_req, res) => res.sendFile(path.join(__dirname, '../public/join.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, '../public/play.html')));

wss.on('connection', (ws) => {
  registerClient(ws);
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'JOIN') await handlePlayerJoin(ws, msg.name, msg.emoji, msg.avatar);
      else if (msg.type === 'ANSWER') await handlePlayerAnswer(ws, msg.value);
    } catch (e) {
      console.error('WS error', e);
    }
  });
});

const PORT = process.env.PORT ?? 3000;
migrate().then(async () => {
  await initEventPolling();
  server.listen(PORT, () => console.log(`Quiz app on :${PORT}`));
});
