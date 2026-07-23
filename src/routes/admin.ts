import { Router } from 'express';
import QRCode from 'qrcode';
import { basicAuth } from '../middleware/auth';
import { pool } from '../db';
import { startSession, advancePhase, getCurrentSession } from '../game/engine';
import { getSecret } from '../secrets';

const router = Router();
router.use(basicAuth);

function buildJoinUrl(req: any): string {
  const base = getSecret('PUBLIC_BASE_URL');
  if (base) return `${base.replace(/\/$/, '')}/quiz-producto/join`;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'localhost';
  return `${proto}://${host}/quiz-producto/join`;
}

router.get('/api/quizzes', async (_req, res) => {
  const r = await pool.query('SELECT * FROM quizzes ORDER BY created_at DESC');
  res.json(r.rows);
});

router.post('/api/quizzes', async (req, res) => {
  const { title, month_year } = req.body;
  const r = await pool.query(`INSERT INTO quizzes (title,month_year) VALUES ($1,$2) RETURNING *`, [title, month_year]);
  res.json(r.rows[0]);
});

router.delete('/api/quizzes/:id', async (req, res) => {
  const id = req.params.id;
  await pool.query('DELETE FROM answers WHERE session_id IN (SELECT id FROM sessions WHERE quiz_id=$1)', [id]);
  await pool.query('DELETE FROM sessions WHERE quiz_id=$1', [id]);
  await pool.query('DELETE FROM quizzes WHERE id=$1', [id]);
  res.json({ ok: true });
});

router.post('/api/quizzes/:id/reset', async (req, res) => {
  await pool.query("UPDATE quizzes SET status='draft' WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

router.get('/api/quizzes/:id/questions', async (req, res) => {
  const r = await pool.query('SELECT * FROM questions WHERE quiz_id=$1 ORDER BY sort_order', [req.params.id]);
  res.json(r.rows);
});

router.post('/api/quizzes/:id/questions', async (req, res) => {
  const { type, prompt, options, correct_answer, time_limit, sort_order, image_url } = req.body;
  const r = await pool.query(
    `INSERT INTO questions (quiz_id,type,prompt,options,correct_answer,time_limit,sort_order,image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id, type, prompt, options ? JSON.stringify(options) : null, correct_answer ?? null, time_limit ?? 20, sort_order ?? 0, image_url ?? null]
  );
  res.json(r.rows[0]);
});

router.put('/api/questions/:id', async (req, res) => {
  const { type, prompt, options, correct_answer, time_limit, sort_order, image_url } = req.body;
  const r = await pool.query(
    `UPDATE questions SET type=$1,prompt=$2,options=$3,correct_answer=$4,time_limit=$5,sort_order=$6,image_url=$7 WHERE id=$8 RETURNING *`,
    [type, prompt, options ? JSON.stringify(options) : null, correct_answer ?? null, time_limit, sort_order, image_url ?? null, req.params.id]
  );
  res.json(r.rows[0]);
});

router.delete('/api/questions/:id', async (req, res) => {
  await pool.query('DELETE FROM questions WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

router.post('/api/sessions/start', async (req, res) => {
  try {
    const { quizId } = req.body;
    const s = await startSession(quizId);
    const joinUrl = buildJoinUrl(req);
    const qr = await QRCode.toDataURL(joinUrl);
    res.json({ sessionId: s.sessionId, joinUrl, qr });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/api/sessions/qr', async (req, res) => {
  const s = getCurrentSession();
  if (!s) return res.status(404).json({ error: 'No hay sesión activa' });
  const joinUrl = buildJoinUrl(req);
  const qr = await QRCode.toDataURL(joinUrl);
  res.json({ qr, joinUrl });
});

router.post('/api/sessions/next', async (_req, res) => {
  try { await advancePhase(); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/api/sessions/current', (_req, res) => {
  const s = getCurrentSession();
  res.json(s ? { sessionId: s.sessionId, phase: s.phase, questionIndex: s.questionIndex } : null);
});

router.get('/api/roster', async (_req, res) => {
  const r = await pool.query('SELECT * FROM players ORDER BY name');
  res.json(r.rows);
});

router.put('/api/players/:id', async (req, res) => {
  const { name } = req.body;
  const r = await pool.query('UPDATE players SET name=$1 WHERE id=$2 RETURNING *', [name, req.params.id]);
  res.json(r.rows[0]);
});

router.get('/api/rankings/annual', async (_req, res) => {
  const year = new Date().getFullYear();
  const r = await pool.query(
    `WITH session_totals AS (
       SELECT a.session_id, a.player_id, SUM(a.points) AS pts
       FROM answers a
       JOIN sessions s ON s.id = a.session_id
       WHERE EXTRACT(YEAR FROM s.started_at) = $1
       GROUP BY a.session_id, a.player_id
     ),
     session_winners AS (
       SELECT DISTINCT ON (session_id) session_id, player_id
       FROM session_totals
       ORDER BY session_id, pts DESC
     )
     SELECT p.name, p.emoji,
            COUNT(DISTINCT sw.session_id)::int AS victories,
            SUM(a.points)::int AS total_points,
            COUNT(DISTINCT a.session_id)::int AS sessions_played
     FROM answers a
     JOIN players p ON p.id = a.player_id
     JOIN sessions s ON s.id = a.session_id
     LEFT JOIN session_winners sw ON sw.session_id = a.session_id AND sw.player_id = a.player_id
     WHERE EXTRACT(YEAR FROM s.started_at) = $1
     GROUP BY p.id, p.name, p.emoji
     ORDER BY victories DESC, total_points DESC`,
    [year]
  );
  res.json(r.rows.map((row, i) => ({ ...row, position: i + 1 })));
});

router.post('/api/rankings/archive-year', async (_req, res) => {
  const year = new Date().getFullYear();
  const r = await pool.query(
    `WITH session_totals AS (
       SELECT a.session_id, a.player_id, SUM(a.points) AS pts
       FROM answers a
       JOIN sessions s ON s.id = a.session_id
       WHERE EXTRACT(YEAR FROM s.started_at) = $1
       GROUP BY a.session_id, a.player_id
     ),
     session_winners AS (
       SELECT DISTINCT ON (session_id) session_id, player_id
       FROM session_totals
       ORDER BY session_id, pts DESC
     )
     SELECT p.name, p.emoji,
            COUNT(DISTINCT sw.session_id)::int AS victories,
            SUM(a.points)::int AS total_points
     FROM answers a
     JOIN players p ON p.id = a.player_id
     JOIN sessions s ON s.id = a.session_id
     LEFT JOIN session_winners sw ON sw.session_id = a.session_id AND sw.player_id = a.player_id
     WHERE EXTRACT(YEAR FROM s.started_at) = $1
     GROUP BY p.id, p.name, p.emoji
     ORDER BY victories DESC, total_points DESC`,
    [year]
  );
  await pool.query('INSERT INTO season_archives (year,data) VALUES ($1,$2)', [year, JSON.stringify(r.rows)]);
  res.json({ ok: true, archived: r.rows.length });
});

router.get('/api/history', async (_req, res) => {
  const r = await pool.query('SELECT * FROM season_archives ORDER BY year DESC');
  res.json(r.rows);
});

export default router;
