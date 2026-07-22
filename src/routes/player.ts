import { Router } from 'express';
import { getRoster, getPlayers, pool } from '../db';
import { getCurrentSession } from '../game/engine';

const router = Router();

router.get('/api/roster', async (_req, res) => {
  const names = await getRoster();
  res.json(names);
});

router.get('/api/players', async (_req, res) => {
  const players = await getPlayers();
  res.json(players);
});

router.post('/api/players/avatar', async (req, res) => {
  const { name, avatar } = req.body;
  if (!name || !avatar) return res.status(400).json({ error: 'name and avatar required' });
  await pool.query('UPDATE players SET avatar_url=$1 WHERE name=$2', [avatar, name]);
  res.json({ ok: true });
});

router.get('/api/session/state', (_req, res) => {
  const s = getCurrentSession();
  res.json(s ? { sessionId: s.sessionId, phase: s.phase } : null);
});

export default router;
