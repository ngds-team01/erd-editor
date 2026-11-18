import type * as Y from 'yjs'
import { canonicalDoc, docHash } from './model'

// 해시를 비교할 문서 1개, name은 결과 출력용 (예: '봇 3', '관찰자')
export type NamedDoc = {
  name: string
  doc: Y.Doc
}

// 같은 해시를 가진 문서 묶음
export type HashGroup = {
  hash: string
  names: string[]
  // 이 묶음의 문서 하나, 수렴 실패 시 어디가 다른지 비교할 때 사용
  sample: Y.Doc
}

export type ConvergeResult = {
  converged: boolean
  // 확인을 시작해서 수렴할 때까지(또는 포기할 때까지) 걸린 시간
  elapsedMs: number
  // 마지막으로 확인한 해시 묶음, 문서가 많은 묶음부터
  groups: HashGroup[]
}

// 문서들을 해시별로 묶음, 묶음이 1개면 모두 같은 상태
export async function groupByHash(docs: NamedDoc[]): Promise<HashGroup[]> {
  const groups = new Map<string, HashGroup>()
  for (const { name, doc } of docs) {
    const hash = await docHash(doc)
    const group = groups.get(hash)
    if (group) {
      group.names.push(name)
    } else {
      groups.set(hash, { hash, names: [name], sample: doc })
    }
  }
  return [...groups.values()].sort((a, b) => b.names.length - a.names.length)
}

// intervalMs마다 해시를 비교해, 모두 같아지면 바로 끝내고 timeoutMs가 지나면 포기
// 편집을 멈춘 직후에는 아직 서버를 오가는 중인 변경이 있으므로 한 번만 비교하지 않고 기다림
export async function waitForConvergence(
  docs: NamedDoc[],
  timeoutMs: number,
  intervalMs = 500,
): Promise<ConvergeResult> {
  const startedAt = Date.now()
  for (;;) {
    const groups = await groupByHash(docs)
    const elapsedMs = Date.now() - startedAt
    if (groups.length <= 1) {
      return { converged: true, elapsedMs, groups }
    }
    if (elapsedMs >= timeoutMs) {
      return { converged: false, elapsedMs, groups }
    }
    await sleep(intervalMs)
  }
}

// 두 문서의 canonicalDoc 문자열에서 처음 달라지는 위치와 그 앞뒤 글자, 같으면 null
// 해시만으로는 어디가 다른지 알 수 없어 수렴 실패 시 출력용으로 사용
export function firstDifference(
  a: Y.Doc,
  b: Y.Doc,
  context = 80,
): { index: number; a: string; b: string } | null {
  const left = canonicalDoc(a)
  const right = canonicalDoc(b)
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) {
    index += 1
  }
  if (index === left.length && index === right.length) {
    return null
  }
  const from = Math.max(0, index - context)
  return { index, a: left.slice(from, index + context), b: right.slice(from, index + context) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
