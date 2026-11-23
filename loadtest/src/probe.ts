// 동기화 지연 측정 (실험 1·3)
// 보내는 봇이 측정용 테이블 이름을 probe-{seq}로 바꾸고, 다른 파드에 붙은 받는 봇이 그 순번을 받은 시각을 기록
// 보낸 시각은 문서에 싣지 않고 이 프로세스의 메모리에만 적어 둠 → 문서에는 평범한 이름 변경만 남아 docHash·수렴 판정 규칙이 그대로
// 보내는 봇과 받는 봇이 같은 프로세스에 있어 같은 시계로 재므로 컴퓨터 간 시계 차이가 없음
import type * as Y from 'yjs'
import { createTable, getTables, updateTable } from './model'
import type { TableMap } from './model'

// 측정용 테이블의 물리명, 무작위 편집(actions.ts)은 이 이름의 테이블을 고르지 않음
export const PROBE_PHYSICAL_NAME = 'loadtest_probe'
// 측정용 테이블 논리명 형식, 숫자 부분이 순번
const PROBE_NAME_PATTERN = /^probe-(\d+)$/

// 측정 경로: update = 문서 변경, awareness = 편집 중 표시 (3-b에서 추가)
export type ProbePath = 'update' | 'awareness'

// 측정값 1개, 시각은 epoch ms (소수점 아래까지)
export type ProbeSample = {
  path: ProbePath
  seq: number
  sentAt: number
  receivedAt: number
  latencyMs: number
}

// 측정용 시계: performance.now()는 컴퓨터 시계를 바꿔도 거꾸로 가지 않고 ms보다 정밀함
// timeOrigin(프로세스 시작 시각)을 더해 CSV에 남길 수 있는 epoch ms로 바꿈
export function probeNow(): number {
  return performance.timeOrigin + performance.now()
}

export function isProbeTable(table: TableMap): boolean {
  return table.get('physicalName') === PROBE_PHYSICAL_NAME
}

// 측정용 테이블 id, 같은 문서로 다시 실행해 이미 있으면 그 테이블을 씀
export function ensureProbeTable(doc: Y.Doc): string {
  for (const [id, table] of getTables(doc)) {
    if (isProbeTable(table)) {
      return id
    }
  }
  return createTable(doc, { logicalName: 'probe-0', physicalName: PROBE_PHYSICAL_NAME, position: { x: 0, y: 0 } })
}

// 측정용 테이블 이름에서 순번을 읽음, 테이블이 아직 없거나 형식이 다르면 null
export function readProbeSeq(doc: Y.Doc, tableId: string): number | null {
  const name = getTables(doc).get(tableId)?.get('logicalName')
  const match = typeof name === 'string' ? PROBE_NAME_PATTERN.exec(name) : null
  return match ? Number(match[1]) : null
}

// 경로 하나의 기록: 보낸 시각과 받은 시각을 순번별로 모음
export type ProbeLog = {
  path: ProbePath
  markSent: (seq: number, at: number) => void
  // 보내지 않은 순번(이전 실행의 probe-0 등)과 이미 받은 순번은 무시
  markReceived: (seq: number, at: number) => void
  samples: () => ProbeSample[]
  sentCount: () => number
  // 보냈지만 받지 못한 순번 수
  missingCount: () => number
}

export function createProbeLog(path: ProbePath): ProbeLog {
  // key = 순번, value = 보낸 시각
  const sent = new Map<number, number>()
  const received = new Map<number, ProbeSample>()

  return {
    path,
    markSent: (seq, at) => {
      sent.set(seq, at)
    },
    markReceived: (seq, at) => {
      const sentAt = sent.get(seq)
      if (sentAt === undefined || received.has(seq)) {
        return
      }
      received.set(seq, { path, seq, sentAt, receivedAt: at, latencyMs: at - sentAt })
    },
    samples: () => [...received.values()].sort((a, b) => a.seq - b.seq),
    sentCount: () => sent.size,
    missingCount: () => sent.size - received.size,
  }
}

// 보내는 쪽(문서): intervalMs마다 측정용 테이블 이름을 probe-{seq}로 바꾸고 보낸 시각을 기록
// 반환값: 멈추는 함수
export function startUpdateSender(
  doc: Y.Doc,
  tableId: string,
  log: ProbeLog,
  intervalMs: number,
  now: () => number = probeNow,
): () => void {
  let seq = 0
  const timer = setInterval(() => {
    seq += 1
    // updateTable이 끝나기 전에 provider가 서버로 보내므로, 보낸 시각을 먼저 적음
    log.markSent(seq, now())
    updateTable(doc, tableId, { logicalName: `probe-${seq}` })
  }, intervalMs)
  return () => clearInterval(timer)
}

// 받는 쪽(문서): 문서가 바뀔 때마다 측정용 테이블 이름에서 순번을 읽어 받은 시각을 기록
// 반환값: 감시를 멈추는 함수
export function watchUpdates(
  doc: Y.Doc,
  tableId: string,
  log: ProbeLog,
  now: () => number = probeNow,
): () => void {
  // 'update'는 다른 봇의 편집에도 발생하지만, 순번이 그대로면 markReceived가 무시함
  const onUpdate = () => {
    const seq = readProbeSeq(doc, tableId)
    if (seq !== null) {
      log.markReceived(seq, now())
    }
  }
  doc.on('update', onUpdate)
  return () => doc.off('update', onUpdate)
}
