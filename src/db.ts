import { Pool, PoolConfig } from 'pg';
import { getSecret } from './secrets';

const DB_HOST = getSecret('DB_HOST') ?? 'localhost';
const DB_PORT = parseInt(getSecret('DB_PORT') ?? '5432');
const DB_NAME = getSecret('DB_NAME') ?? 'postgres';
const DB_USER = getSecret('DB_USER') ?? 'postgres';

console.log(`DB: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);

const config: PoolConfig = {
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: getSecret('DB_PASSWORD') ?? getSecret('DB_PASS') ?? '',
  ssl: getSecret('DB_SSL') === 'true' ? { rejectUnauthorized: false } : false,
};

export const pool = new Pool(config);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  emoji TEXT NOT NULL DEFAULT '😊',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS quizzes (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  month_year TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  quiz_id INTEGER REFERENCES quizzes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options JSONB,
  correct_answer TEXT,
  time_limit INTEGER NOT NULL DEFAULT 20,
  sort_order INTEGER NOT NULL DEFAULT 0,
  image_url TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  quiz_id INTEGER REFERENCES quizzes(id),
  status TEXT NOT NULL DEFAULT 'lobby',
  phase TEXT NOT NULL DEFAULT 'lobby',
  question_index INTEGER NOT NULL DEFAULT 0,
  phase_started_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS answers (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  question_id INTEGER REFERENCES questions(id),
  player_id INTEGER REFERENCES players(id),
  value TEXT NOT NULL,
  answered_at TIMESTAMPTZ DEFAULT NOW(),
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, question_id, player_id)
);
CREATE TABLE IF NOT EXISTS season_archives (
  id SERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  data JSONB NOT NULL,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS quiz_events (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS session_players (
  session_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (session_id, player_id)
);
CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at DATE,
  ends_at DATE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT 'lobby';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS question_index INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phase_started_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE session_players ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL;
`;

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
  console.log('DB migrations done');
}

export async function getRoster(): Promise<string[]> {
  const res = await pool.query('SELECT name FROM players ORDER BY name');
  return res.rows.map((r) => r.name);
}

export async function getPlayers(): Promise<{ name: string; emoji: string; avatar_url: string | null }[]> {
  const res = await pool.query('SELECT name, emoji, avatar_url FROM players ORDER BY name');
  return res.rows;
}
