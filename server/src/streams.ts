// Redis Streams 편집 기록 (docs/contracts.md 6.1, 6.2)과 복원 때 기록 읽기 (6.4).
// 이 파드 클라이언트가 만든 업데이트만 FLUSH_INTERVAL_MS 동안 모아 Y.mergeUpdates로 합친 뒤
// XADD doc:{docId}:log * u <bin> pod <podId> 1회로 기록한다.
// 버퍼는 문서 객체와 따로 둔다. Redis가 끊긴 동안 문서가 내려가도 재연결 후 기록할 수 있게.
import * as Y from 'yjs'
import { config } from './config.js'
import { countMessage } from './metrics.js'
import { isRedisReady, redis } from './redis.js'
import type { LogReader } from './restore.js'

/** docId → 아직 기록하지 못한 업데이트 */
const pending = new Map<string, Uint8Array[]>()
/** docId → 예약된 flush 타이머 */
const timers = new Map<string, NodeJS.Timeout>()
/** 기록이 실패하고 있는 docId. 재시도마다 같은 경고가 쌓이지 않게 처음 한 번만 로그를 남긴다. */
const failing = new Set<string>()

export function logKey(docId: string): string {
  return `doc:${docId}:log`
}

// 복원 때 XRANGE 한 번에 읽는 항목 수. 로그가 길어도 한 번에 큰 응답을 받지 않게 나눠 읽는다.
const XRANGE_PAGE = 500

/** 필드 목록 [k1, v1, k2, v2, …]에서 u 값을 찾는다. */
function updateField(fields: Buffer[]): Uint8Array | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i].toString() === 'u') return fields[i + 1]
  }
  return undefined
}

/** contracts 6.4-3: XRANGE doc:{docId}:log (<afterId> + 로 이후 기록을 읽는다 (afterId가 '0'이면 처음부터). */
export const streamLog: LogReader = {
  async *readAfter(docId, afterId) {
    let start = afterId === '0' ? '-' : `(${afterId}`
    for (;;) {
      const page = await redis.xrangeBuffer(logKey(docId), start, '+', 'COUNT', XRANGE_PAGE)
      for (const [rawId, fields] of page) {
        const id = rawId.toString()
        const update = updateField(fields)
        if (update) yield { id, update }
        start = `(${id}`
      }
      if (page.length < XRANGE_PAGE) return
    }
  },
}

/** 아직 기록하지 못한 업데이트 (복원 때 같이 적용한다. Redis가 끊긴 동안 문서를 내렸다 다시 연 경우) */
export function pendingUpdates(docId: string): Uint8Array[] {
  return [...(pending.get(docId) ?? [])]
}

/** FLUSH_INTERVAL_MS 뒤 flush를 예약한다. 이미 예약돼 있으면 그대로 둔다. */
function schedule(docId: string) {
  if (timers.has(docId)) return
  timers.set(
    docId,
    setTimeout(() => {
      timers.delete(docId)
      void flush(docId)
    }, config.flushIntervalMs),
  )
}

/** 이 파드 클라이언트의 업데이트를 버퍼에 넣는다. Pub/Sub로 받은 변경은 넣지 않는다 (중복 기록 방지). */
export function record(docId: string, update: Uint8Array) {
  let buffer = pending.get(docId)
  if (!buffer) {
    buffer = []
    pending.set(docId, buffer)
  }
  buffer.push(update)
  schedule(docId)
}

/**
 * 버퍼를 지금 기록한다. 문서를 내리기 직전(5.3-6)과 종료 직전(7.2)에도 부른다.
 * Redis가 끊겨 있으면 버퍼를 그대로 두고, 다시 연결되면 flushAll이 기록한다.
 */
export async function flush(docId: string): Promise<void> {
  const timer = timers.get(docId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(docId)
  }
  const buffer = pending.get(docId)
  if (!buffer || buffer.length === 0) return
  if (!isRedisReady()) {
    // 끊긴 동안 버퍼가 길어지지 않게 하나로 합쳐 둔다 (contracts 6.2 "메모리 버퍼에 계속 병합")
    if (buffer.length > 1) pending.set(docId, [Y.mergeUpdates(buffer)])
    return
  }
  pending.delete(docId)

  const merged = buffer.length === 1 ? buffer[0] : Y.mergeUpdates(buffer)
  try {
    await redis.xadd(
      logKey(docId),
      '*',
      'u',
      Buffer.from(merged.buffer, merged.byteOffset, merged.byteLength),
      'pod',
      config.podId,
    )
    countMessage('xadd')
    if (failing.delete(docId)) console.log(`[doc:${docId}] Streams 기록 다시 성공`)
  } catch (err) {
    // 실패한 업데이트는 버퍼 앞에 되돌린다.
    // (Yjs 업데이트는 적용 순서와 상관없이 같은 결과가 되므로 순서가 바뀌어도 된다)
    pending.set(docId, [merged, ...(pending.get(docId) ?? [])])
    // 연결은 살아 있는데 명령만 실패하면(OOM, 타임아웃 등) ready 이벤트가 오지 않고,
    // 문서가 이미 내려갔거나 편집이 더 없으면 record()도 오지 않는다. 그래서 직접 다시 예약한다.
    schedule(docId)
    if (!failing.has(docId)) {
      failing.add(docId)
      console.warn(`[doc:${docId}] Streams 기록 실패, ${config.flushIntervalMs}ms마다 다시 시도: ${(err as Error).message}`)
    }
  }
}

export async function flushAll(): Promise<void> {
  await Promise.all([...pending.keys()].map((docId) => flush(docId)))
}

// 6.2: Redis가 다시 붙으면 끊긴 동안 모아 둔 업데이트를 즉시 기록한다.
redis.on('ready', () => void flushAll())
