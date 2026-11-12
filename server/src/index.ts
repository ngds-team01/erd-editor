import http from 'node:http'
import { WebSocketServer } from 'ws'
import { config } from './config.js'
import { setupConnection } from './doc.js'
import { register } from './metrics.js'
import { closeRedis } from './redis.js'

// docs/contracts.md 4.1: ws://host/ws/{docId}, docId는 영문·숫자·_- 1~64자
const WS_PREFIX = '/ws/'
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/
const CLOSE_INVALID_DOC_ID = 4400
const CLOSE_SERVICE_RESTART = 1012

// contracts 7.2: SIGTERM 후 HAProxy가 이 파드를 빼도록 기다리는 시간
const SHUTDOWN_DRAIN_MS = 5_000
// terminationGracePeriodSeconds(30초)보다 먼저 스스로 끝낸다.
const SHUTDOWN_FORCE_EXIT_MS = 25_000

// readiness: 리스닝 중이고 종료 중이 아니면 true.
// contracts 7.1: Redis 연결 상태와는 무관하다 (Redis가 끊겨도 LOCAL 문서는 계속 편집된다).
let ready = false
let shuttingDown = false

// new URL()은 "//" 같은 경로에서 예외를 던져 프로세스가 죽으므로 쓰지 않는다.
function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?', 1)[0]
}


const server = http.createServer((req, res) => {
  const pathname = pathOf(req.url)
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
  } else if (req.method === 'GET' && pathname === '/readyz') {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' }).end(ready ? 'ready' : 'not ready')
  } else if (req.method === 'GET' && pathname === '/metrics') {
    // contracts 7.3: Prometheus 형식 지표
    register.metrics().then(
      (body) => res.writeHead(200, { 'content-type': register.contentType }).end(body),
      () => res.writeHead(500).end(),
    )
  } else {
    res.writeHead(404).end()
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy())
  const pathname = pathOf(req.url)
  if (!pathname.startsWith(WS_PREFIX)) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  if (!ready) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n')
    return
  }
  const docId = pathname.slice(WS_PREFIX.length)
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', (err) => console.warn(`[doc:${docId}] WebSocket 오류, 연결 종료: ${err.message}`))
    // contracts 4.1: 형식이 틀린 docId는 연결 후 4400으로 닫는다. 클라이언트는 재접속하지 않는다.
    if (!DOC_ID.test(docId)) {
      ws.close(CLOSE_INVALID_DOC_ID, 'invalid docId')
      return
    }
    setupConnection(ws, docId)
  })
})

server.listen(config.port, () => {
  ready = true
  console.log(`[${config.podId}] 편집 서버 시작 :${config.port} (ws://localhost:${config.port}/ws/{docId})`)
})

// contracts 7.2 종료 순서: /readyz 503 → 대기 → (2주차: Streams flush) → 1012로 연결 종료 → 종료
async function shutdown(signal: string, drainMs: number) {
  if (shuttingDown) return
  shuttingDown = true
  ready = false
  console.log(`[${config.podId}] ${signal} 받음, ${drainMs}ms 뒤 연결 종료`)
  setTimeout(() => {
    console.warn(`[${config.podId}] ${SHUTDOWN_FORCE_EXIT_MS}ms 안에 종료되지 않아 강제 종료`)
    process.exit(1)
  }, SHUTDOWN_FORCE_EXIT_MS).unref()

  await new Promise((resolve) => setTimeout(resolve, drainMs))
  // TODO(백엔드, 2주차): 모든 문서의 Streams 버퍼 flush, 문서별 LEAVE 발행
  for (const ws of wss.clients) ws.close(CLOSE_SERVICE_RESTART, 'server restarting')
  server.close(async () => {
    await closeRedis()
    process.exit(0)
  })
}
process.on('SIGTERM', () => void shutdown('SIGTERM', SHUTDOWN_DRAIN_MS))
// 로컬 개발에서 Ctrl+C는 기다리지 않는다.
process.on('SIGINT', () => void shutdown('SIGINT', 0))
