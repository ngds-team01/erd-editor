// Redis Streams 편집 기록 (docs/contracts.md 6.1, 6.2).
// 이 파드 클라이언트가 만든 업데이트만 FLUSH_INTERVAL_MS 동안 모아 Y.mergeUpdates로 합친 뒤
// XADD doc:{docId}:log * u <bin> pod <podId> 1회로 기록한다.
// 버퍼는 문서 객체와 따로 둔다. Redis가 끊긴 동안 문서가 내려가도 재연결 후 기록할 수 있게.
import * as Y from 'yjs'
import { config } from './config.js'
import { isRedisReady, redis } from './redis.js'

/** docId → 아직 기록하지 못한 업데이트 */
const pending = new Map<string, Uint8Array[]>()
/** docId → 예약된 flush 타이머 */
const timers = new Map<string, NodeJS.Timeout>()

export function logKey(docId: string): string {
  return `doc:${docId}:log`
}

/** 이 파드 클라이언트의 업데이트를 버퍼에 넣는다. Pub/Sub로 받은 변경은 넣지 않는다 (중복 기록 방지). */
export function record(docId: string, update: Uint8Array) {
  let buffer = pending.get(docId)
  if (!buffer) {
    buffer = []
    pending.set(docId, buffer)
  }
  buffer.push(update)
  if (!timers.has(docId)) {
    timers.set(
      docId,
      setTimeout(() => {
        timers.delete(docId)
        void flush(docId)
      }, config.flushIntervalMs),
    )
  }
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
  } catch (err) {
    // 실패한 업데이트는 버퍼 앞에 되돌려 다음 flush에 다시 시도한다.
    // (Yjs 업데이트는 적용 순서와 상관없이 같은 결과가 되므로 순서가 바뀌어도 된다)
    pending.set(docId, [merged, ...(pending.get(docId) ?? [])])
    console.warn(`[doc:${docId}] Streams 기록 실패, 재연결 후 다시 시도: ${(err as Error).message}`)
  }
}

export async function flushAll(): Promise<void> {
  await Promise.all([...pending.keys()].map((docId) => flush(docId)))
}

// 6.2: Redis가 다시 붙으면 끊긴 동안 모아 둔 업데이트를 즉시 기록한다.
redis.on('ready', () => void flushAll())
