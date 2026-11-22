// close code별 재접속 대기 시간 계산 (contracts 4.3)

// 서버 재시작·종료 중 (graceful shutdown)
export const CLOSE_SERVICE_RESTART = 1012
// 잘못된 docId
export const CLOSE_INVALID_DOC_ID = 4400

// 1012를 받았을 때 무작위로 기다리는 최대 시간: 모든 사용자가 같은 순간에 다음 파드로 몰리지 않게 흩음
const RESTART_MAX_DELAY_MS = 500
// 지수 백오프의 첫 대기 시간과 최대 대기 시간
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000
// 지터 비율: 대기 시간을 ±20% 범위에서 흔듦
const JITTER_RATIO = 0.2

// 다음 재접속까지 기다릴 ms를 돌려주고, 재접속하지 않아야 하면 null
export function reconnectDelay(code: number, attempt: number, random: () => number = Math.random): number | null {
  if (code === CLOSE_INVALID_DOC_ID) return null
  if (code === CLOSE_SERVICE_RESTART) return random() * RESTART_MAX_DELAY_MS

  // 0.5s → 1s → 2s … 최대 10s
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS)
  // random 0 → 0.8배, random 1 → 1.2배
  return base * (1 - JITTER_RATIO + 2 * JITTER_RATIO * random())
}
