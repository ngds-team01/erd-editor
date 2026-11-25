// 문서 하나에 딸린 봇 묶음: 편집하는 봇, 지연 측정 봇(--probe), 관찰자
// index.ts는 이 묶음 단위로 접속 → 편집 → 멈춤 → 수렴 확인 → 관찰자 확인을 진행함
// 여러 문서 부하(--docs)에서는 문서마다 묶음을 하나씩 만들고, 봇 번호는 firstIndex로 묶음끼리 겹치지 않게 이어 씀
import { createBot } from './bot'
import type { Bot } from './bot'
import type { NamedDoc } from './converge'
import {
  createProbeLog,
  ensureProbeTable,
  probeNow,
  startAwarenessSender,
  startUpdateSender,
  watchAwareness,
  watchUpdates,
} from './probe'
import type { ProbeLog } from './probe'

export type DocGroupOptions = {
  // 편집하는 봇·보내는 봇·관찰자가 붙는 주소 (HAProxy 입구)
  url: string
  // 받는 봇만 붙는 주소 (--receiver-url, 지정하지 않으면 url과 같음)
  receiverUrl: string
  docId: string
  // 이 묶음의 첫 봇 번호, 시드(seed + 번호)와 로그 이름에 쓰므로 묶음끼리 겹치면 안 됨
  firstIndex: number
  // 편집하는 봇 수
  bots: number
  seed: number
  rate: number
  // 봇 접속 사이 간격(ms)
  rampMs: number
  // 지연 측정 봇을 띄울지 (--probe)
  probe: boolean
  probeIntervalMs: number
}

// 지연 측정용 봇 두 개와 그 기록
export type ProbeBots = {
  // url(HAProxy)로 붙어 측정용 변경을 보내는 봇
  sender: Bot
  // receiverUrl로 붙어 받은 시각을 기록하는 봇, 다른 파드에 붙이면 Redis를 거치는 SHARED 경로를 잼
  receiver: Bot
  updateLog: ProbeLog
  awarenessLog: ProbeLog
  // 측정용 테이블을 준비하고 두 경로(update·awareness)의 보내기·받기를 시작
  start: () => void
  stopSending: () => void
  stopWatching: () => void
}

export type DocGroup = {
  docId: string
  // 무작위 편집을 하는 봇
  bots: Bot[]
  // 지연 측정 봇, --probe를 끄면 null
  probe: ProbeBots | null
  // 편집하는 봇 + 측정 봇: 수렴 확인·재접속 기록·종료를 함께 하는 봇 전부 (관찰자는 빠짐)
  everyBot: Bot[]
  // 수렴 확인에 쓰는 이름 붙은 문서 ('봇 3', '보내는 봇', '받는 봇')
  docs: NamedDoc[]
  // 다음 묶음(또는 부하 봇)이 쓸 첫 봇 번호
  nextIndex: number
  // 모든 봇이 서버와 첫 동기화를 마칠 때까지 대기
  waitSynced: (timeoutMs: number) => Promise<void>
  // 측정용 변경 보내기와 무작위 편집을 시작
  start: () => void
  // 측정용 변경 보내기를 멈추고, 편집을 멈춘 뒤 진행 중인 드래그가 끝날 때까지 대기
  stop: () => Promise<void>
  // 받는 봇의 기록을 멈춤, 수렴을 기다리는 동안 늦게 온 측정용 변경까지 받은 뒤 부름
  stopWatching: () => void
  // 관찰자를 새로 접속시켜 동기화를 마칠 때까지 대기, 접속부터 동기화까지 걸린 시간을 돌려줌
  connectObserver: (timeoutMs: number) => Promise<{ observer: Bot; syncMs: number }>
  // 측정을 멈추고 관찰자까지 모든 봇의 접속을 끊음, 여러 번 불러도 됨
  destroy: () => void
}

// 봇 번호: 편집하는 봇 = firstIndex … firstIndex + bots − 1, 보내는 봇 = 그다음, 받는 봇 = 그다음, 관찰자 = 그다음
// (측정을 꺼도 번호는 비워 둠: 관찰자·부하 봇 번호가 --probe에 따라 바뀌지 않게)
export async function createDocGroup(options: DocGroupOptions): Promise<DocGroup> {
  const { url, docId, firstIndex, seed, rate } = options
  const bots: Bot[] = []
  // 봇을 ramp 간격으로 하나씩 접속시킴, HAProxy가 봇을 파드에 나눠 배정할 시간을 줌
  for (let offset = 0; offset < options.bots; offset += 1) {
    bots.push(createBot({ url, docId, index: firstIndex + offset, seed, rate }))
    await sleep(options.rampMs)
  }
  const senderIndex = firstIndex + options.bots
  const probe = options.probe ? createProbeBots(options, senderIndex) : null
  const everyBot = probe ? [...bots, probe.sender, probe.receiver] : bots
  const docs: NamedDoc[] = bots.map((bot) => ({ name: `봇 ${bot.index}`, doc: bot.doc }))
  if (probe) {
    docs.push({ name: '보내는 봇', doc: probe.sender.doc }, { name: '받는 봇', doc: probe.receiver.doc })
  }
  const observerIndex = senderIndex + 2
  let observer: Bot | null = null

  return {
    docId,
    bots,
    probe,
    everyBot,
    docs,
    nextIndex: observerIndex + 1,
    waitSynced: async (timeoutMs) => {
      await Promise.all(everyBot.map((bot) => bot.waitSynced(timeoutMs)))
    },
    start: () => {
      probe?.start()
      bots.forEach((bot) => bot.start())
    },
    stop: async () => {
      probe?.stopSending()
      await Promise.all(bots.map((bot) => bot.stop()))
    },
    stopWatching: () => probe?.stopWatching(),
    connectObserver: async (timeoutMs) => {
      const startedAt = probeNow()
      // 편집은 하지 않는 봇, 서버가 가진 상태를 받아옴
      observer = createBot({ url, docId, index: observerIndex, seed, rate })
      await observer.waitSynced(timeoutMs)
      return { observer, syncMs: probeNow() - startedAt }
    },
    destroy: () => {
      probe?.stopSending()
      probe?.stopWatching()
      everyBot.forEach((bot) => bot.destroy())
      observer?.destroy()
    },
  }
}

function createProbeBots(options: DocGroupOptions, senderIndex: number): ProbeBots {
  const common = { docId: options.docId, seed: options.seed, rate: options.rate }
  const sender = createBot({ ...common, url: options.url, index: senderIndex })
  const receiver = createBot({ ...common, url: options.receiverUrl, index: senderIndex + 1 })
  // 경로마다 기록장을 따로 둠, 순번도 경로마다 1부터 셈
  const updateLog = createProbeLog('update')
  const awarenessLog = createProbeLog('awareness')
  // 멈추는 함수 모음, 시작 전이면 비어 있어 멈춰도 아무 일도 없음
  let senderStops: (() => void)[] = []
  let watcherStops: (() => void)[] = []

  return {
    sender,
    receiver,
    updateLog,
    awarenessLog,
    start: () => {
      // 보내는 봇 문서에 측정용 테이블을 만듦, 받는 봇에는 이 생성이 먼저 도착한 뒤 이름 변경이 도착함
      const tableId = ensureProbeTable(sender.doc)
      // 받는 쪽을 먼저 붙여 첫 순번부터 기록
      watcherStops = [
        watchUpdates(receiver.doc, tableId, updateLog),
        // awareness의 clientID = 그 봇 Y.Doc의 clientID, 받는 봇은 이 번호로 보내는 봇의 상태를 찾음
        watchAwareness(receiver.awareness, sender.awareness.clientID, awarenessLog),
      ]
      senderStops = [
        startUpdateSender(sender.doc, tableId, updateLog, options.probeIntervalMs),
        startAwarenessSender(sender.awareness, awarenessLog, options.probeIntervalMs),
      ]
    },
    stopSending: () => senderStops.forEach((stop) => stop()),
    stopWatching: () => watcherStops.forEach((stop) => stop()),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
