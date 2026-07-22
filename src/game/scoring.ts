import { DbQuestion } from '../types';

const MAX = 1000;
const MIN = 500;

function speedScore(timeUsedMs: number, timeLimitMs: number): number {
  const ratio = Math.min(timeUsedMs / timeLimitMs, 1);
  return Math.round(MIN + (MAX - MIN) * (1 - ratio));
}

export function computePoints(
  q: DbQuestion,
  value: string,
  timeUsedMs: number,
  allValues: string[]
): number {
  const tl = q.time_limit * 1000;
  switch (q.type) {
    case 'multiple_choice':
    case 'true_false':
      return value === q.correct_answer ? speedScore(timeUsedMs, tl) : 0;

    case 'rank': {
      try {
        const given: string[] = JSON.parse(value);
        const expected: string[] = JSON.parse(q.correct_answer ?? '[]');
        const n = expected.length;
        if (n < 2) return 0;
        let correctPairs = 0;
        const totalPairs = (n * (n - 1)) / 2;
        for (let i = 0; i < n - 1; i++) {
          for (let j = i + 1; j < n; j++) {
            const gi = given.indexOf(expected[i]);
            const gj = given.indexOf(expected[j]);
            if (gi !== -1 && gj !== -1 && gi < gj) correctPairs++;
          }
        }
        if (correctPairs === 0) return 0;
        return Math.round((correctPairs / totalPairs) * speedScore(timeUsedMs, tl));
      } catch { return 0; }
    }

    case 'estimation': {
      const val = parseFloat(value);
      const real = parseFloat(q.correct_answer ?? '0');
      if (isNaN(val) || real === 0) return 0;
      const dist = Math.abs(val - real) / Math.abs(real);
      return Math.round(MAX / (1 + dist * 2));
    }

    case 'majority': {
      const counts: Record<string, number> = {};
      for (const v of allValues) counts[v] = (counts[v] ?? 0) + 1;
      const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      const rank = sorted.indexOf(value);
      const tiers = [MAX, 700, MIN];
      const base = tiers[rank] ?? 0;
      if (base === 0) return 0;
      const speedBonus = Math.round(100 * (1 - Math.min(timeUsedMs / tl, 1)));
      return base + speedBonus;
    }

    default: return 0;
  }
}
