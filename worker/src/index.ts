// 스냅샷 워커 (docs/contracts.md 6.3). SNAPSHOT_INTERVAL_MS(기본 30초)마다 모든 문서의 스냅샷을 만든다.
import http from 'node:http'
import { config } from './config.js'
import { cycleSeconds, entriesTotal, lastCycleTimestamp, register, snapshotsTotal, trimmedTotal } from './metrics.js'
import { closeRedis, isRedisReady, redisLog } from './redis.js'
import { s3Snapshots } from './s3.js'
import { Snapshotter } from './snapshot.js'

// 종료 시 진행 중인 주기를 기다리는 최대 시간 (terminationGracePeriodSeconds 30초보다 짧게)
const SHUTDOWN_WAIT_MS = 20_000

// 같은 오류가 주기마다 쌓이지 않게, 오류 내용이 바뀔 때만 로그를 남긴다.
let lastError = ''
function logError(where: string, err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const key = `${where} ${message}`
  if (key === lastError) return
  lastError = key
  console.warn(`[${config.name}] ${where} 실패: ${message}`)
}

const snapshotter = new Snapshotter(redisLog, s3Snapshots, (docId, err) => logError(`doc:${docId}`, err))

let timer: NodeJS.Timeout | undefined
let running: Promise<void> | undefined
let stopping = false
let redisWarned = false

async function cycle() {
  // Redis가 끊겨 있으면 이번 주기는 건너뛴다 (다시 붙으면 다음 주기에 한다)
  if (!isRedisReady()) {
    if (!redisWarned) console.warn(`[${config.name}] Redis 연결 안 됨, 스냅샷 주기를 건너뜀`)
    redisWarned = true
    return
  }
  redisWarned = false
  const end = cycleSeconds.startTimer()
  try {
    const result = await snapshotter.runCycle()
    const seconds = end()
    lastCycleTimestamp.setToCurrentTime()
    snapshotsTotal.inc({ result: 'saved' }, result.saved)
    snapshotsTotal.inc({ result: 'failed' }, result.failed)
    entriesTotal.inc(result.entries)
    trimmedTotal.inc(result.trimmed)
    if (result.saved > 0 || result.failed > 0) {
      console.log(
        `[${config.name}] 스냅샷 ${result.saved}개 저장, 실패 ${result.failed}개 ` +
          `(문서 ${result.docs}개, 반영 ${result.entries}항목, 정리 ${result.trimmed}항목, ${seconds.toFixed(2)}초)`,
      )
    }
    if (result.failed === 0) lastError = ''
  } catch (err) {
    // SCAN 자체가 실패한 경우 (Redis가 주기 도중 끊김 등)
    end()
    logError('스냅샷 주기', err)
  }
}

/** 주기가 끝난 뒤 다음 주기를 예약한다. 한 주기가 길어져도 겹쳐 돌지 않는다. */
function scheduleNext() {
  if (stopping) return
  timer = setTimeout(() => {
    running = cycle().finally(() => {
      running = undefined
      scheduleNext()
    })
  }, config.intervalMs)
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?', 1)[0]
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
  } else if (req.method === 'GET' && pathname === '/metrics') {
    register.metrics().then(
      (body) => res.writeHead(200, { 'content-type': register.contentType }).end(body),
      () => res.writeHead(500).end(),
    )
  } else {
    res.writeHead(404).end()
  }
})

server.listen(config.port, () => {
  console.log(
    `[${config.name}] 스냅샷 워커 시작 :${config.port}, ${config.intervalMs}ms마다 ` +
      `→ ${config.s3Endpoint ?? 'AWS S3'}/${config.s3Bucket}`,
  )
  scheduleNext()
})

// 진행 중인 주기는 끝까지 기다린다. 중간에 끊어도 스냅샷이 깨지지는 않지만(업로드는 통째로 성공하거나 실패한다),
// 업로드 직후 XTRIM 전에 끊기면 정리가 한 주기 늦어진다.
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  clearTimeout(timer)
  console.log(`[${config.name}] ${signal} 받음, 종료`)
  setTimeout(() => {
    console.warn(`[${config.name}] ${SHUTDOWN_WAIT_MS}ms 안에 주기가 끝나지 않아 강제 종료`)
    process.exit(1)
  }, SHUTDOWN_WAIT_MS).unref()
  await running
  server.close()
  await closeRedis()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
