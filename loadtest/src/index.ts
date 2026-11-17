import { parseArgs } from 'node:util'
import { createBot } from './bot'
import type { Bot } from './bot'
import { assertSingleYjs } from './singleYjs'

// 문서 ID 형식 (contracts 4.1), 틀리면 서버가 4400으로 닫으므로 미리 막음
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// 실행 인자, 예: npm run bot -- --bots 20 --duration 60
const { values } = parseArgs({
  options: {
    // 서버 주소 (HAProxy 입구, contracts 4.1)
    url: { type: 'string', default: 'ws://localhost:8088/ws' },
    // 편집할 문서, 지정하지 않으면 매번 새 문서
    doc: { type: 'string', default: `loadtest-${Date.now()}` },
    bots: { type: 'string', default: '10' },
    // 편집하는 시간(초)
    duration: { type: 'string', default: '30' },
    // 봇 1개의 초당 편집 수
    rate: { type: 'string', default: '2' },
    // 난수 시드, 같은 값을 주면 같은 편집 순서를 다시 실행
    seed: { type: 'string', default: String(Date.now() % 1_000_000) },
    // 봇 접속 사이 간격(ms), HAProxy가 봇을 파드에 나눠 배정할 시간을 줌
    ramp: { type: 'string', default: '100' },
  },
})

const options = {
  url: values.url,
  docId: values.doc,
  bots: positiveNumber('bots', values.bots),
  durationSec: positiveNumber('duration', values.duration),
  rate: positiveNumber('rate', values.rate),
  seed: Math.floor(Number(values.seed)),
  rampMs: Math.max(0, Number(values.ramp) || 0),
}
// 봇 1개가 서버와 첫 동기화를 끝내야 하는 시간
const SYNC_TIMEOUT_MS = 10_000
// 편집 중 진행 상황을 출력하는 간격
const PROGRESS_INTERVAL_MS = 5_000

async function main(): Promise<void> {
  if (!DOC_ID_PATTERN.test(options.docId)) {
    throw new Error(`문서 ID 형식이 틀립니다: ${options.docId} (영문, 숫자, _, - 로 1~64자)`)
  }
  // 봇을 띄우기 전에 yjs가 한 벌인지 먼저 확인, 두 벌이면 편집이 깨지므로 바로 멈춤
  assertSingleYjs()

  console.log(
    `문서 ${options.docId} · 봇 ${options.bots}개 · ${options.durationSec}초 · 봇당 초당 ${options.rate}회 · seed ${options.seed}`,
  )
  console.log(`서버 ${options.url}`)

  // WebsocketProvider는 Node에서 provider마다 process 'exit' 리스너를 1개씩 등록함
  // 기본 한도 10개를 넘으면 메모리 누수 경고가 나므로 봇 수만큼 한도를 늘림
  process.setMaxListeners(options.bots + 10)

  // 1. 봇을 ramp 간격으로 하나씩 접속시키고, 모두 첫 동기화가 끝날 때까지 대기
  const bots: Bot[] = []
  for (let index = 0; index < options.bots; index += 1) {
    bots.push(createBot({ url: options.url, docId: options.docId, index, seed: options.seed, rate: options.rate }))
    await sleep(options.rampMs)
  }
  try {
    await Promise.all(bots.map((bot) => bot.waitSynced(SYNC_TIMEOUT_MS)))
    console.log(`봇 ${bots.length}개 동기화 완료, 편집 시작`)

    // 2. 정해진 시간 동안 편집
    bots.forEach((bot) => bot.start())
    const startedAt = Date.now()
    const progress = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`  ${elapsed}초 · 편집 ${totalActions(bots)}회`)
    }, PROGRESS_INTERVAL_MS)
    await sleep(options.durationSec * 1000)
    clearInterval(progress)

    // 3. 편집 멈춤 (진행 중인 드래그는 끝까지)
    await Promise.all(bots.map((bot) => bot.stop()))
    printSummary(bots)
  } finally {
    bots.forEach((bot) => bot.destroy())
  }
}

// 편집 종류별 합계, 보낸 update 수, 끊김 수 출력
function printSummary(bots: Bot[]): void {
  const actions: Record<string, number> = {}
  let updates = 0
  let disconnects = 0
  for (const bot of bots) {
    for (const [action, count] of Object.entries(bot.stats.actions)) {
      actions[action] = (actions[action] ?? 0) + count
    }
    updates += bot.stats.updatesSent
    disconnects += bot.stats.disconnects
  }
  console.log(`편집 종료 · 편집 ${totalActions(bots)}회 · 보낸 update ${updates}개 · 끊김 ${disconnects}회`)
  for (const [action, count] of Object.entries(actions).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action.padEnd(15)} ${count}`)
  }
}

function totalActions(bots: Bot[]): number {
  return bots.reduce(
    (sum, bot) => sum + Object.values(bot.stats.actions).reduce((acc, count) => acc + count, 0),
    0,
  )
}

function positiveNumber(name: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} 값은 0보다 큰 숫자여야 합니다: ${raw}`)
  }
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)


