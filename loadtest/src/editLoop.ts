// 봇의 편집 반복: 일정 간격으로 무작위 편집을 하고, 편집한 대상을 awareness editing에 올림
// 정식 봇(bot.ts)과 가벼운 봇(lightBot.ts)이 같은 반복을 씀, 둘의 차이는 받은 편집을 반영하느냐뿐
import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import { randomEdit } from './actions'
import type { ActionName, EditLimits } from './actions'
import { setEditing } from './presence'
import type { Random } from './random'

// 드래그 중 position을 쓰는 간격 (contracts 2.7: 최대 50ms에 한 번)
const DRAG_INTERVAL_MS = 50

export type EditLoopOptions = {
  doc: Y.Doc
  awareness: Awareness
  // 편집 종류·대상과 쉬는 간격을 고르는 시드 난수
  random: Random
  // 1초에 하는 편집 수 (드래그 1번 = 편집 1번)
  rate: number
  limits: EditLimits
}

export type EditLoop = {
  // 편집 종류별 횟수
  actions: Partial<Record<ActionName, number>>
  // 반복 시작, 이미 돌고 있으면 무시
  start: () => void
  // 반복을 멈추고, 진행 중인 드래그가 끝날 때까지 대기
  stop: () => Promise<void>
}

export function createEditLoop(options: EditLoopOptions): EditLoop {
  const { doc, awareness, random, rate, limits } = options
  const actions: Partial<Record<ActionName, number>> = {}
  let running = false
  // 반복이 돌고 있는 Promise, stop에서 끝날 때까지 기다리는 데 사용
  let loop: Promise<void> = Promise.resolve()

  // 드래그 좌표 사이에 쉬는 방법: 50ms 쉬기
  const dragWait = () => sleep(DRAG_INTERVAL_MS)

  // 편집 1번, 드래그면 좌표를 50ms마다 나눠 씀
  // 편집한 대상을 awareness editing에 올림, 대상이 그대로면 setEditing이 보내지 않음 (client와 같음)
  async function editOnce(): Promise<void> {
    const { action, editing } = await randomEdit(doc, random, limits, dragWait)
    actions[action] = (actions[action] ?? 0) + 1
    setEditing(awareness, editing)
  }

  async function run(): Promise<void> {
    // 평균 간격 1000/rate ms, 봇들이 같은 순간에 몰리지 않게 0.5~1.5배로 흔듦
    const interval = 1000 / rate
    while (running) {
      await editOnce()
      await sleep(interval * (0.5 + random.next()))
    }
  }

  return {
    actions,
    start: () => {
      if (running) {
        return
      }
      running = true
      loop = run()
    },
    // 해시 비교는 모든 봇이 편집을 멈춘 뒤 해야 하므로, 반복이 실제로 끝날 때까지 기다림
    stop: async () => {
      running = false
      await loop
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
