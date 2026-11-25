// 부하 프로세스 진입점: 측정 프로세스(index.ts)가 child_process.fork로 띄움 (loadProcess.ts)
// 가벼운 봇 여러 개를 만들어 측정 프로세스의 지시(start·stop)대로 편집하고, 멈추면 통계를 보고한 뒤 종료
//
// 왜 따로 프로세스인가: 봇 수십 개가 받는 메시지를 처리하느라 바쁜 스레드에 받는 봇(지연 측정)이 같이 있으면
// 받은 메시지가 차례를 기다려 측정 지연이 부풀려짐 → 부하 봇은 다른 프로세스(다른 스레드)에서 돌림
import { startEventLoopMonitor } from './eventLoop'
import type { EventLoopSummary } from './eventLoop'
import { createLightBot } from './lightBot'
import type { LightBot } from './lightBot'
import type { FromWorker, LoadStats, LoadWorkerOptions, ToWorker } from './loadProcess'

// 측정 프로세스가 실행 인자로 넘긴 옵션 (JSON 문자열 하나)
const options = JSON.parse(process.argv[2] ?? '{}') as LoadWorkerOptions

// 측정 프로세스에 메시지를 보냄, done은 보내기가 끝난 뒤 불림
function report(message: FromWorker, done?: () => void): void {
  process.send?.(message, undefined, undefined, () => done?.())
}

// 측정 프로세스가 먼저 죽으면(Ctrl+C 등) 남지 않고 같이 끝남
process.on('disconnect', () => process.exit(0))

const bots: LightBot[] = []
// 편집 시작 때 만들어짐, 멈출 때 불러 이 프로세스의 이벤트 루프 요약을 받음
let stopEventLoopMonitor: (() => EventLoopSummary) | null = null

async function prepare(): Promise<void> {
  // 봇 번호는 측정 프로세스가 정해 줌 (firstIndex부터 count개), 프로세스끼리 시드·이름이 겹치지 않음
  for (let offset = 0; offset < options.count; offset += 1) {
    const index = options.firstIndex + offset
    bots.push(
      createLightBot({
        url: options.url,
        docId: options.docId,
        index,
        seed: options.seed,
        rate: options.rate,
        onReconnect: (event) => {
          if (event.kind === 'stop') {
            console.error(`가벼운 봇 ${index}: 서버가 문서 주소를 거부해 재접속하지 않습니다 (code ${event.code})`)
            return
          }
          // 한 번도 동기화하지 못한 채 닫혔으면 '접속 실패' (bot.ts와 같은 문구)
          const what = event.beforeFirstSync ? '접속 실패' : '끊김'
          console.log(
            `가벼운 봇 ${index}: ${what} (code ${event.code}) → ${Math.round(event.delayMs)}ms 뒤 재접속 (연속 실패 ${event.attempt}회)`,
          )
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, options.rampMs))
  }
  await Promise.all(bots.map((bot) => bot.waitSynced(options.syncTimeoutMs)))
}

// 편집을 멈추고 통계를 모은 뒤 접속을 닫음
async function finish(): Promise<LoadStats> {
  await Promise.all(bots.map((bot) => bot.stop()))
  const eventLoop = stopEventLoopMonitor?.() ?? null
  const sum = (pick: (bot: LightBot) => number) => bots.reduce((total, bot) => total + pick(bot), 0)
  const actions: LoadStats['actions'] = {}
  for (const bot of bots) {
    for (const [action, count] of Object.entries(bot.stats.actions) as [keyof LoadStats['actions'], number][]) {
      actions[action] = (actions[action] ?? 0) + count
    }
  }
  const stats: LoadStats = {
    bots: bots.length,
    actions,
    updatesSent: sum((bot) => bot.stats.updatesSent),
    messagesReceived: sum((bot) => bot.stats.messagesReceived),
    bytesReceived: sum((bot) => bot.stats.bytesReceived),
    disconnects: sum((bot) => bot.stats.disconnects),
    eventLoop,
  }
  bots.forEach((bot) => bot.destroy())
  return stats
}

process.on('message', (message: ToWorker) => {
  if (message.type === 'start') {
    // 이 프로세스의 바쁜 시간도 편집 구간만 잼 (측정 프로세스와 같은 구간)
    stopEventLoopMonitor = startEventLoopMonitor()
    bots.forEach((bot) => bot.start())
    return
  }
  if (message.type === 'stop') {
    finish().then(
      // 통계를 다 보낸 뒤 종료 (보내기 전에 끝내면 메시지가 사라짐)
      (stats) => report({ type: 'stopped', stats }, () => process.exit(0)),
      (error: unknown) => fail(error),
    )
  }
})

function fail(error: unknown): void {
  bots.forEach((bot) => bot.destroy())
  report({ type: 'failed', message: error instanceof Error ? error.message : String(error) }, () => process.exit(1))
}

prepare().then(() => report({ type: 'ready' }), fail)
