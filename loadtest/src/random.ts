// 시드(seed)를 받는 난수 생성기, 같은 시드면 같은 순서로 같은 값이 나와 같은 편집 시나리오를 다시 돌릴 수 있음
// Math.random()은 시드를 정할 수 없어 쓰지 않음
// 단, table·column id는 contracts 2.7대로 model이 crypto.randomUUID()로 만들므로 매번 다름
export type Random = {
  // 0 이상 1 미만의 실수
  next: () => number
  // min 이상 max 이하의 정수
  int: (min: number, max: number) => number
  // 배열에서 하나를 고름, 빈 배열이면 undefined
  pick: <T>(items: readonly T[]) => T | undefined
  // probability(0~1) 확률로 true
  chance: (probability: number) => boolean
}

// mulberry32: 32비트 정수 상태 하나로 동작하는 짧고 빠른 난수 생성 알고리즘 (암호용 아님, 테스트용으로 충분)
export function createRandom(seed: number): Random {
  // >>> 0: 숫자를 0 이상의 32비트 정수로 맞춤
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => (items.length === 0 ? undefined : items[Math.floor(next() * items.length)]),
    chance: (probability) => next() < probability,
  }
}
