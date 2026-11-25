// 동기화 지연 측정 (실험 1·3)
// 보내는 봇이 측정용 테이블 이름을 probe-{seq}로 바꾸고, 다른 파드에 붙은 받는 봇이 그 순번을 받은 시각을 기록
// 보낸 시각은 문서에 싣지 않고 이 프로세스의 메모리에만 적어 둠 → 문서에는 평범한 이름 변경만 남아 docHash·수렴 판정 규칙이 그대로
// 보내는 봇과 받는 봇이 같은 프로세스에 있어 같은 시계로 재므로 컴퓨터 간 시계 차이가 없음
// awareness는 같은 방식으로 상태에 probe: { seq }만 올림 (보낸 시각은 역시 메모리에만)
// y-protocols는 y-websocket이 함께 설치하는 패키지, 여기서는 타입만 가져와 실행 코드에는 남지 않음
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { createTable, getTables, updateTable } from './model'
import type { TableMap } from './model'

// 측정용 테이블의 물리명, 무작위 편집(actions.ts)은 이 이름의 테이블을 고르지 않음
export const PROBE_PHYSICAL_NAME = 'loadtest_probe'
// 측정용 테이블 논리명 형식, 숫자 부분이 순번
const PROBE_NAME_PATTERN = /^probe-(\d+)$/

// 측정 경로: update = 문서 변경, awareness = 편집 중 표시
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

// awareness 상태의 probe 필드에서 순번을 읽음, 없거나 형식이 다르면 null
// 받은 상태는 다른 클라이언트가 올린 값이라 presence.ts처럼 형식을 검사한 뒤 사용
export function readAwarenessSeq(state: unknown): number | null {
  if (typeof state !== 'object' || state === null) {
    return null
  }
  const probe = (state as { probe?: unknown }).probe
  if (typeof probe !== 'object' || probe === null) {
    return null
  }
  const seq = (probe as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isInteger(seq) ? seq : null
}

// 보내는 쪽(awareness): intervalMs마다 내 상태의 probe 필드를 { seq }로 바꾸고 보낸 시각을 기록
// user·editing 필드는 그대로 두고 probe만 더하므로 client 화면은 이 필드를 무시함 (collectPeers는 user·editing만 읽음)
// 반환값: 멈추는 함수
export function startAwarenessSender(
  awareness: Awareness,
  log: ProbeLog,
  intervalMs: number,
  now: () => number = probeNow,
): () => void {
  let seq = 0
  const timer = setInterval(() => {
    seq += 1
    // 문서와 마찬가지로 setLocalStateField 안에서 provider가 바로 서버로 보내므로, 보낸 시각을 먼저 적음
    log.markSent(seq, now())
    awareness.setLocalStateField('probe', { seq })
  }, intervalMs)
  return () => clearInterval(timer)
}

// awareness 'change' 이벤트가 넘겨주는 값: 상태가 새로 생긴·바뀐·사라진 clientId 목록
type AwarenessChanges = { added: number[]; updated: number[]; removed: number[] }

// 받는 쪽(awareness): 보내는 봇(senderClientId)의 상태가 바뀔 때마다 probe.seq를 읽어 받은 시각을 기록
// 'change'는 내용이 실제로 바뀔 때만 발생 (15초마다 같은 상태를 다시 보내는 'update'는 제외)
// 반환값: 감시를 멈추는 함수
export function watchAwareness(
  awareness: Awareness,
  senderClientId: number,
  log: ProbeLog,
  now: () => number = probeNow,
): () => void {
  const onChange = ({ added, updated }: AwarenessChanges) => {
    // 재접속하면 보내는 봇이 added로 다시 들어오므로 둘 다 봄, 같은 순번은 markReceived가 무시
    if (!added.includes(senderClientId) && !updated.includes(senderClientId)) {
      return
    }
    const seq = readAwarenessSeq(awareness.getStates().get(senderClientId))
    if (seq !== null) {
      log.markReceived(seq, now())
    }
  }
  awareness.on('change', onChange)
  return () => awareness.off('change', onChange)
}
