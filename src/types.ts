export type QuestionType = 'multiple_choice' | 'true_false' | 'rank' | 'estimation' | 'majority';

export interface DbQuestion {
  id: number;
  quiz_id: number;
  type: QuestionType;
  prompt: string;
  options: string[] | null;
  correct_answer: string | null;
  time_limit: number;
  sort_order: number;
  image_url: string | null;
}

export type GamePhase = 'lobby' | 'reading' | 'answering' | 'question_results' | 'waiting' | 'finished';

export interface PlayerAnswer {
  value: string;
  answeredAt: number;
  points: number;
}

export interface ActiveSession {
  sessionId: number;
  quizId: number;
  phase: GamePhase;
  questionIndex: number;
  questions: DbQuestion[];
  phaseStartTime: number;
  phaseTimer: ReturnType<typeof setTimeout> | null;
  answers: Record<number, Record<number, PlayerAnswer>>;
  playerInfo: Map<number, { name: string; emoji: string; avatar_url: string | null }>;
}
