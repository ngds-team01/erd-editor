// Redis Streams 읽기·정리 (docs/contracts.md 6.1, 6.3).
// 편집 서버가 doc:{docId}:log 에 필드 u(Yjs update), pod(podId)로 기록한 항목을 읽는다.
import { Redis } from 'ioredis'
import { config } from './config.js'
import type { LogEntry, LogStore } from './snapshot.js'

const RETRY_MAX_DELAY_MS = 5_000
const SCAN_COUNT = 200
// XRANGE 한 번에 읽는 항목 수. 로그가 길어도 한 번에 큰 응답을 받지 않게 나눠 읽는다.
const XRANGE_PAGE = 500

const LOG_KEY = /^doc:(.+):log$/

export const redis = new Redis(config.redisUrl, {
  // 끊기면 0.2초, 0.4초, … 최대 5초 간격으로 계속 재접속한다.
  retryStrategy: (times) => Math.min(times * 200, RETRY_MAX_DELAY_MS),
  // 끊긴 동안 보낸 명령은 쌓아 두지 않고 바로 실패시킨다. 그 주기는 건너뛰고 다음 주기에 다시 한다.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
})

// 끊길 때 한 번, 다시 붙을 때 한 번만 로그를 남긴다 (재시도마다 반복되지 않게).
let connected = false
let retries = 0
let firstError = ''
const log = (message: string) => console.log(`[${config.name}] Redis ${message}`)
redis.on('ready', () => {
  connected = true
  log(retries > 0 ? `다시 연결됨 (${retries}번 재시도)` : `연결됨: ${config.redisUrl}`)
  retries = 0
  firstError = ''
})
redis.on('close', () => {
  if (!connected) return
  connected = false
  log('연결 끊김, 재접속 시도 중')
})
redis.on('reconnecting', () => {
  retries += 1
})
redis.on('error', (err: NodeJS.ErrnoException) => {
  // Node의 연결 거부 오류는 message가 비어 있을 수 있어 code를 대신 쓴다.
  const reason = err.message || err.code || 'unknown'
  if (firstError) return
  firstError = reason
  log(`오류: ${reason}`)
})

export function isRedisReady(): boolean {
  return redis.status === 'ready'
}

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }
}

function logKey(docId: string): string {
  return `doc:${docId}:log`
}

/** 필드 목록 [k1, v1, k2, v2, …]에서 u 값을 찾는다. */
function updateField(fields: Buffer[]): Uint8Array | undefined {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i].toString() === 'u') return fields[i + 1]
  }
  return undefined
}

export const redisLog: LogStore = {
  async listDocs() {
    // SCAN은 같은 키를 두 번 돌려줄 수 있어 Set으로 거른다.
    const docs = new Set<string>()
    const stream = redis.scanStream({ match: 'doc:*:log', type: 'stream', count: SCAN_COUNT })
    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const key of keys) {
        const match = LOG_KEY.exec(key)
        if (match) docs.add(match[1])
      }
    }
    return [...docs]
  },

  async latestId(docId) {
    const [last] = await redis.xrevrange(logKey(docId), '+', '-', 'COUNT', 1)
    return last ? last[0] : null
  },

  async *readAfter(docId, afterId): AsyncGenerator<LogEntry> {
    // afterId는 이미 스냅샷에 들어간 항목이므로 그 다음부터 읽는다 ("(" = 그 ID 제외)
    let start = afterId === '0' ? '-' : `(${afterId}`
    for (;;) {
      const page = await redis.xrangeBuffer(logKey(docId), start, '+', 'COUNT', XRANGE_PAGE)
      for (const [rawId, fields] of page) {
        const id = rawId.toString()
        const update = updateField(fields)
        if (update) yield { id, update }
        else console.warn(`[doc:${docId}] Streams 항목 ${id}에 u 필드가 없어 건너뜀`)
        start = `(${id}`
      }
      if (page.length < XRANGE_PAGE) return
    }
  },

  async trim(docId, minId) {
    // MINID: minId보다 작은 ID를 지운다 (minId 자체는 남는다)
    return redis.xtrim(logKey(docId), 'MINID', minId)
  },
}
