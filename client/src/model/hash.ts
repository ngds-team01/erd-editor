import * as Y from 'yjs'
import { getRelations, getTables } from './schema'

// 객체 키를 정렬해 직렬화한 JSON (2.8), Y.Map의 키 순서는 편집을 받은 순서에 따라 클라이언트마다 다를 수 있음
// 배열은 순서 자체가 값이므로(예: uniques.columnIds) 정렬하지 않음
// undefined 처리는 JSON.stringify와 같게 맞춤: 객체에서는 키를 빼고, 배열에서는 null로 씀
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJSON(item))).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`)
    return `{${entries.join(',')}}`
  }
  // 문자열·숫자·boolean·null, 표현할 수 없는 값(함수 등)은 null로 씀
  return JSON.stringify(value) ?? 'null'
}

// 해시를 계산하는 문서 내용 (2.8), 수렴 실패 시 어디가 다른지 비교할 때도 사용
// doc.toJSON()은 getMap()을 호출하지 않은 문서에서 {}를 돌려주므로 최상위 Map을 직접 읽음
export function canonicalDoc(doc: Y.Doc): string {
  return canonicalJSON({
    tables: getTables(doc).toJSON(),
    relations: getRelations(doc).toJSON(),
  })
}

// 수렴 검증용 문서 해시 (2.8): canonicalDoc의 SHA-256을 16진수 64자로 반환
// Web Crypto(crypto.subtle)는 브라우저와 Node 20+ 양쪽에 있어 client와 loadtest가 같은 함수를 씀, 대신 비동기
export async function docHash(doc: Y.Doc): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDoc(doc))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
