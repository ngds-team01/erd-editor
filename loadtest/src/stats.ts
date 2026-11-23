// 측정값 요약 (백분위)

export type LatencySummary = {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

// p(0~1) 백분위, 값이 없으면 NaN
// 스프레드시트의 PERCENTILE(=PERCENTILE.INC)과 같은 방식: 정렬한 뒤 (개수-1)×p 위치를 앞뒤 값으로 선형 보간
// → samples.csv를 스프레드시트로 열어 다시 계산해도 같은 값이 나옴
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN
  }
  const rank = (sorted.length - 1) * p
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower)
}

export function summarize(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length === 0 ? Number.NaN : sorted[sorted.length - 1],
  }
}
