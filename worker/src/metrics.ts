// 워커 Prometheus 지표. GET /metrics로 노출한다 (contracts 7.5: 8081).
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()
collectDefaultMetrics({ register })

/** 문서별 스냅샷 결과. saved = 업로드 성공, conflict = 다른 워커가 먼저 바꿔서 안 올림, failed = 그 문서 처리 실패 */
export const snapshotsTotal = new Counter({
  name: 'worker_snapshots_total',
  help: '문서별 스냅샷 처리 결과 수',
  labelNames: ['result'],
  registers: [register],
})
for (const result of ['saved', 'conflict', 'failed']) snapshotsTotal.inc({ result }, 0)

export const entriesTotal = new Counter({
  name: 'worker_snapshot_entries_total',
  help: '스냅샷에 반영한 Streams 항목 수',
  registers: [register],
})

export const trimmedTotal = new Counter({
  name: 'worker_stream_trimmed_total',
  help: 'XTRIM으로 지운 Streams 항목 수',
  registers: [register],
})

export const cycleSeconds = new Histogram({
  name: 'worker_cycle_seconds',
  help: '스냅샷 주기 한 번(모든 문서 처리)에 걸린 시간',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
})

/** 마지막으로 끝까지 돈 주기의 시각. 이 값이 멈춰 있으면 워커가 일을 못 하고 있는 것이다. */
export const lastCycleTimestamp = new Gauge({
  name: 'worker_last_cycle_timestamp_seconds',
  help: '마지막으로 끝난 스냅샷 주기 시각 (Unix 초)',
  registers: [register],
})
