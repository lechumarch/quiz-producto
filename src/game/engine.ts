import { WebSocket } from 'ws';
import { pool } from '../db';
import { ActiveSession, DbQuestion, PlayerAnswer } from '../types';
import { computePoints } from './scoring';

const READING_MS = 8000;

let session: ActiveSession | null = null;
let lastEventId = 0;
const clients = new Map<WebSocket, { playerId: number | null; name: string | null; emoji: string | null; avatarUrl: string | null }>();

export function registerClient(ws: WebSocket): void {
  clients.set(ws, { playerId: null, name: null, emoji: null, avatarUrl: null });
  ws.on('close', () => clients.delete(ws));
  if (session?.phase === 'lobby') {
    getSessionPlayers(session.sessionId)
      .then(players => send(ws, { type: 'LOBBY_UPDATE', players }))
      .catch(() => {});
  } else if (!session) {
    tryRestoreSession().catch(() => {});
  }
}

export function getCurrentSession(): ActiveSession | null { return session; }

export async function initEventPolling(): Promise<void> {
  await tryRestoreSession();
  const r = await pool.query('SELECT COALESCE(MAX(id), 0) as max_id FROM quiz_events');
  lastEventId = r.rows[0].max_id;
  setInterval(pollEvents, 100);
}

async function pollEvents(): Promise<void> {
  try {
    const r = await pool.query(
      'SELECT id, event FROM quiz_events WHERE id > $1 ORDER BY id LIMIT 50',
      [lastEventId]
    );
    for (const row of r.rows) {
      lastEventId = row.id;
      handleEvent(row.event);
    }
  } catch (_) { /* ignore transient errors */ }
}

function handleEvent(msg: any): void {
  if (msg.type === 'PHASE_QUESTION_RESULTS') {
    for (const [ws, client] of clients) {
      if (!client.playerId) {
        // Host / proyector: no es jugador, pero necesita la distribución y el
        // ranking para mostrar la pantalla de resultados (sin datos personales).
        send(ws, {
          type: 'PHASE_QUESTION_RESULTS',
          distribution: msg.distribution,
          questionType: msg.questionType,
          correctAnswer: msg.correctAnswer,
          rankings: msg.rankings,
        });
        continue;
      }
      const pa = (msg.playerAnswers || {})[String(client.playerId)];
      send(ws, {
        type: 'PHASE_QUESTION_RESULTS',
        distribution: msg.distribution,
        questionType: msg.questionType,
        correctAnswer: msg.correctAnswer,
        myAnswer: pa?.value ?? null,
        myPoints: pa?.points ?? 0,
        myCorrect: pa?.correct ?? false,
        rankings: msg.rankings,
      });
    }
  } else if (msg.type === 'PLAYER_ANSWER') {
    if (session?.phase === 'answering') {
      const q = session.questions[session.questionIndex];
      if (q.id === msg.questionId && msg.playerId) {
        if (!session.answers[q.id]) session.answers[q.id] = {};
        if (!session.answers[q.id][msg.playerId]) {
          session.answers[q.id][msg.playerId] = { value: msg.value, answeredAt: msg.timeUsedMs, points: 0 };
        }
      }
    }
  } else {
    localBroadcast(msg);
  }
}

async function tryRestoreSession(): Promise<void> {
  if (session) return;
  try {
    const r = await pool.query(
      `SELECT s.id, s.quiz_id, s.phase, s.question_index
       FROM sessions s
       JOIN quizzes q ON q.id = s.quiz_id
       WHERE q.status = 'active' AND s.status != 'finished'
       ORDER BY s.created_at DESC LIMIT 1`
    );
    if (!r.rows.length) return;
    const row = r.rows[0];
    const qRes = await pool.query<DbQuestion>('SELECT * FROM questions WHERE quiz_id=$1 ORDER BY sort_order', [row.quiz_id]);
    if (!qRes.rows.length) return;
    session = {
      sessionId: row.id,
      quizId: row.quiz_id,
      phase: row.phase || 'lobby',
      questionIndex: row.question_index || 0,
      questions: qRes.rows,
      phaseStartTime: Date.now(),
      phaseTimer: null,
      answers: {},
    };
    console.log(`Restored session ${session.sessionId} phase=${session.phase}`);
  } catch (e) {
    console.error('tryRestoreSession error', e);
  }
}

async function publishEvent(event: object): Promise<void> {
  if (!session) return;
  await pool.query('INSERT INTO quiz_events (session_id, event) VALUES ($1,$2)', [session.sessionId, JSON.stringify(event)]);
}

async function saveSessionState(): Promise<void> {
  if (!session) return;
  await pool.query(
    'UPDATE sessions SET phase=$1, question_index=$2, phase_started_at=NOW() WHERE id=$3',
    [session.phase, session.questionIndex, session.sessionId]
  );
}

function localBroadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function send(ws: WebSocket, msg: object): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function getSessionPlayers(sessionId: number): Promise<{ name: string; emoji: string; avatar_url?: string | null }[]> {
  const r = await pool.query('SELECT name, emoji, avatar_url FROM session_players WHERE session_id=$1', [sessionId]);
  return r.rows;
}

async function broadcastLobby(): Promise<void> {
  if (!session) return;
  const players = await getSessionPlayers(session.sessionId);
  await publishEvent({ type: 'LOBBY_UPDATE', players });
}

export async function startSession(quizId: number): Promise<ActiveSession> {
  const qRes = await pool.query<DbQuestion>('SELECT * FROM questions WHERE quiz_id=$1 ORDER BY sort_order', [quizId]);
  if (!qRes.rows.length) throw new Error('El quiz no tiene preguntas');

  const sRes = await pool.query(
    `INSERT INTO sessions (quiz_id, status, phase, question_index, started_at) VALUES ($1,'lobby','lobby',0,NOW()) RETURNING id`,
    [quizId]
  );
  await pool.query(`UPDATE quizzes SET status='active' WHERE id=$1`, [quizId]);

  session = {
    sessionId: sRes.rows[0].id,
    quizId,
    phase: 'lobby',
    questionIndex: 0,
    questions: qRes.rows,
    phaseStartTime: Date.now(),
    phaseTimer: null,
    answers: {},
  };
  await broadcastLobby();
  return session;
}

export async function handlePlayerJoin(ws: WebSocket, name: string, emoji: string, avatar?: string): Promise<void> {
  if (!session) await tryRestoreSession();
  if (avatar) {
    await pool.query(
      `INSERT INTO players (name, emoji, avatar_url) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET avatar_url = EXCLUDED.avatar_url`,
      [name, emoji, avatar]
    );
  } else {
    await pool.query(
      `INSERT INTO players (name, emoji) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`,
      [name, emoji]
    );
  }
  const idRes = await pool.query('SELECT id, emoji, avatar_url FROM players WHERE name=$1', [name]);
  const playerId: number = idRes.rows[0].id;
  const storedEmoji: string = idRes.rows[0].emoji;
  const storedAvatar: string | null = idRes.rows[0].avatar_url;
  clients.set(ws, { playerId, name, emoji: storedEmoji, avatarUrl: storedAvatar });
  send(ws, { type: 'JOINED', name, emoji: storedEmoji, avatarUrl: storedAvatar });
  if (session?.phase === 'lobby') {
    await pool.query(
      `INSERT INTO session_players (session_id, player_id, name, emoji, avatar_url) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, player_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url`,
      [session.sessionId, playerId, name, storedEmoji, storedAvatar]
    );
    await broadcastLobby();
  }
}

export async function handlePlayerAnswer(ws: WebSocket, value: string): Promise<void> {
  const client = clients.get(ws);
  if (!client?.playerId) return;

  if (!session) await tryRestoreSession();
  if (!session || session.phase !== 'answering') return;

  const q = session.questions[session.questionIndex];
  if (!session.answers[q.id]) session.answers[q.id] = {};
  if (session.answers[q.id][client.playerId]) return;

  const timeUsedMs = Date.now() - session.phaseStartTime;
  session.answers[q.id][client.playerId] = { value, answeredAt: timeUsedMs, points: 0 };
  send(ws, { type: 'ANSWER_RECEIVED' });

  const answeredNow = Object.keys(session.answers[q.id]).length;
  const totalConnected = [...clients.values()].filter(c => c.playerId).length;
  localBroadcast({ type: 'ANSWER_COUNT', answered: answeredNow, total: totalConnected });

  await pool.query(
    `INSERT INTO quiz_events (session_id, event) VALUES ($1,$2)`,
    [session.sessionId, JSON.stringify({ type: 'PLAYER_ANSWER', playerId: client.playerId, questionId: q.id, value, timeUsedMs })]
  );

  const totalKnown = [...clients.values()].filter(c => c.playerId).length;
  if (totalKnown > 0 && Object.keys(session.answers[q.id]).length >= totalKnown) {
    if (session.phaseTimer) clearTimeout(session.phaseTimer);
    await finishAnswering();
  }
}

export async function advancePhase(): Promise<void> {
  if (!session) throw new Error('No hay sesión activa');
  const s = session;
  if (s.phaseTimer) { clearTimeout(s.phaseTimer); s.phaseTimer = null; }

  if (s.phase === 'lobby') { await startReading(); }
  else if (s.phase === 'reading') { await startAnswering(); }
  else if (s.phase === 'answering') { await finishAnswering(); }
  else if (s.phase === 'question_results') { await goToWaiting(); }
  else if (s.phase === 'waiting') {
    if (s.questionIndex < s.questions.length - 1) {
      s.questionIndex++;
      await startReading();
    } else {
      await finishSession();
    }
  }
}

async function startReading(): Promise<void> {
  if (!session) return;
  const s = session;
  if (!['lobby', 'waiting'].includes(s.phase)) return;
  s.phase = 'reading';
  s.phaseStartTime = Date.now();
  await saveSessionState();
  const q = s.questions[s.questionIndex];
  await publishEvent({ type: 'PHASE_READING', questionIndex: s.questionIndex, total: s.questions.length, question: { prompt: q.prompt, type: q.type, imageUrl: q.image_url }, duration: READING_MS / 1000 });
  s.phaseTimer = setTimeout(async () => {
    if (session?.phase === 'reading') {
      await pollEvents();
      await startAnswering();
    }
  }, READING_MS);
}

async function startAnswering(): Promise<void> {
  if (!session) return;
  const s = session;
  if (s.phase !== 'reading') return;
  s.phase = 'answering';
  s.phaseStartTime = Date.now();
  await saveSessionState();
  const q = s.questions[s.questionIndex];
  await publishEvent({ type: 'PHASE_ANSWERING', questionIndex: s.questionIndex, total: s.questions.length, question: { id: q.id, prompt: q.prompt, type: q.type, options: q.options, imageUrl: q.image_url, timeLimit: q.time_limit } });
  s.phaseTimer = setTimeout(async () => {
    await pollEvents();
    await finishAnswering();
  }, q.time_limit * 1000);
}

async function finishAnswering(): Promise<void> {
  if (!session) return;
  const s = session;
  if (s.phase !== 'answering') return;
  s.phase = 'question_results';
  await saveSessionState();
  const q = s.questions[s.questionIndex];
  const qAnswers = s.answers[q.id] ?? {};
  const allValues = Object.values(qAnswers).map((a: PlayerAnswer) => a.value);

  const playerAnswers: Record<string, { value: string; points: number; correct: boolean }> = {};
  for (const [pidStr, ans] of Object.entries(qAnswers) as [string, PlayerAnswer][]) {
    (ans as PlayerAnswer).points = computePoints(q, ans.value, ans.answeredAt, allValues);
    await pool.query(
      `INSERT INTO answers (session_id,question_id,player_id,value,time_used_ms,points) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [s.sessionId, q.id, parseInt(pidStr), ans.value, ans.answeredAt, ans.points]
    );
    playerAnswers[pidStr] = { value: ans.value, points: (ans as PlayerAnswer).points, correct: isCorrect(q, ans.value) };
  }

  const distribution = buildDistribution(q, qAnswers as Record<number, PlayerAnswer>);
  const rankings = await computeRankings(s.sessionId);

  await publishEvent({
    type: 'PHASE_QUESTION_RESULTS',
    distribution,
    questionType: q.type,
    correctAnswer: q.type !== 'majority' ? q.correct_answer : null,
    playerAnswers,
    rankings,
  });

}

async function goToWaiting(): Promise<void> {
  if (!session || session.phase !== 'question_results') return;
  session.phase = 'waiting';
  await saveSessionState();
  const players = await getSessionPlayers(session.sessionId);
  await publishEvent({ type: 'PHASE_WAITING', players });
}

function buildDistribution(q: DbQuestion, answers: Record<number, PlayerAnswer>): object {
  if (q.type === 'estimation') {
    return { values: Object.values(answers).map(a => parseFloat(a.value)).filter(v => !isNaN(v)), realValue: parseFloat(q.correct_answer ?? '0') };
  }
  if (q.type === 'rank') {
    return { answerCount: Object.keys(answers).length, correctAnswer: q.correct_answer };
  }
  const counts: Record<string, number> = {};
  for (const a of Object.values(answers)) counts[a.value] = (counts[a.value] ?? 0) + 1;
  const options = q.type === 'true_false' ? ['Verdadero', 'Falso'] : (q.options ?? []);
  return { counts, options };
}

function isCorrect(q: DbQuestion, value?: string): boolean {
  if (!value) return false;
  if (q.type === 'majority' || q.type === 'estimation') return false;
  if (q.type === 'rank') {
    try { return JSON.stringify(JSON.parse(value)) === JSON.stringify(JSON.parse(q.correct_answer ?? '[]')); } catch { return false; }
  }
  return value === q.correct_answer;
}

async function finishSession(): Promise<void> {
  if (!session) return;
  const s = session;
  s.phase = 'finished';
  await pool.query(`UPDATE sessions SET status='finished', phase='finished', finished_at=NOW() WHERE id=$1`, [s.sessionId]);
  await pool.query(`UPDATE quizzes SET status='finished' WHERE id=$1`, [s.quizId]);
  const rankings = await computeRankings(s.sessionId);
  await publishEvent({ type: 'PHASE_FINISHED', champion: rankings[0] ?? null, rankings });
  session = null;
}

async function computeRankings(sessionId: number): Promise<object[]> {
  const r = await pool.query(
    `SELECT p.name, p.emoji, p.avatar_url, SUM(a.points)::int as total_points FROM answers a JOIN players p ON p.id=a.player_id WHERE a.session_id=$1 GROUP BY p.id,p.name,p.emoji,p.avatar_url ORDER BY total_points DESC`,
    [sessionId]
  );
  return r.rows.map((row, i) => ({ ...row, position: i + 1 }));
}
