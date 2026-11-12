// Prometheus 지표 (docs/contracts.md 7.3). GET /metrics로 노출한다.
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export const register = new Registry()
// 프로세스 CPU·메모리 등 기본 지표도 같이 노출한다 (실험 때 파드 부하 확인용)
collectDefaultMetrics({ register })

const MESSAGE_TYPES = ['sync', 'awareness', 'pubsub_in', 'pubsub_out', 'xadd'] as const
export type MessageKind = (typeof MESSAGE_TYPES)[number]

/**
 * - sync, awareness: 클라이언트에게서 받은 WebSocket 메시지
 * - pubsub_out: 이 파드가 발행한 Pub/Sub 메시지
 * - pubsub_in: 이 파드가 구독으로 배달받은 Pub/Sub 메시지 (자기 것·다른 파드 앞 메시지 포함, Redis가 배달한 횟수)
 * - xadd: Streams 기록
 * Redis 작업량 = 전체 파드의 pubsub_out + pubsub_in + xadd 합 (7.3)
 */
const messagesTotal = new Counter({
  name: 'editor_messages_total',
  help: '종류별 메시지 수',
  labelNames: ['type'],
  registers: [register],
})
// 아직 한 번도 안 생긴 종류도 0으로 보이게 미리 만든다 (대시보드 빈칸 방지)
for (const type of MESSAGE_TYPES) messagesTotal.inc({ type }, 0)

export function countMessage(type: MessageKind) {
  messagesTotal.inc({ type })
}

/** 다른 파드의 UPDATE를 받았을 때 now - sentAt */
export const syncLatency = new Histogram({
  name: 'editor_sync_latency_seconds',
  help: 'Pub/Sub로 받은 다른 파드 UPDATE의 지연 (now - sentAt)',
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
  registers: [register],
})

/** contracts 6.4의 2~3단계(스냅샷 읽기 + 로그 적용) 소요 시간. 3주차 복원 구현 때 값을 넣는다. */
export const docRestoreSeconds = new Histogram({
  name: 'editor_doc_restore_seconds',
  help: '문서 복원(스냅샷 + Streams 로그 적용) 소요 시간',
  registers: [register],
})

type Stats = { connections: number; local: number; shared: number }
let readStats: () => Stats = () => ({ connections: 0, local: 0, shared: 0 })

/** 연결 수와 문서 모드 수를 읽는 함수를 등록한다 (doc.ts). 순환 import를 피하려고 함수로 받는다. */
export function setStatsSource(source: () => Stats) {
  readStats = source
}

new Gauge({
  name: 'editor_ws_connections',
  help: '현재 WebSocket 연결 수 (HPA 기준)',
  registers: [register],
  collect() {
    this.set(readStats().connections)
  },
})

new Gauge({
  name: 'editor_docs',
  help: '열린 문서 수 (모드별)',
  labelNames: ['mode'],
  registers: [register],
  collect() {
    const { local, shared } = readStats()
    this.set({ mode: 'local' }, local)
    this.set({ mode: 'shared' }, shared)
  },
})
