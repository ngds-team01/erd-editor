import { describe, expect, it } from 'vitest'
import { ADJECTIVES, ANIMALS, randomNickname } from './nickname'
import { MAX_USER_NAME } from './presence'

// 미리 정한 값을 차례로 돌려주는 가짜 random
const sequence = (...values: number[]) => () => values.shift() ?? 0

describe('randomNickname', () => {
  it('형용사 1개와 동물 1개를 띄어 씀', () => {
    expect(randomNickname(sequence(0, 0))).toBe(`${ADJECTIVES[0]} ${ANIMALS[0]}`)
  })

  it('random 값에 따라 목록의 위치를 고름 (마지막 칸 포함)', () => {
    expect(randomNickname(sequence(0.999, 0.999))).toBe(
      `${ADJECTIVES[ADJECTIVES.length - 1]} ${ANIMALS[ANIMALS.length - 1]}`,
    )
  })

  it('가장 긴 형용사와 가장 긴 동물을 붙여도 20자 이하', () => {
    const longest = (words: readonly string[]) => Math.max(...words.map((word) => [...word].length))
    expect(longest(ADJECTIVES) + 1 + longest(ANIMALS)).toBeLessThanOrEqual(MAX_USER_NAME)
  })

  it('목록에 같은 단어가 두 번 들어 있지 않음', () => {
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length)
    expect(new Set(ANIMALS).size).toBe(ANIMALS.length)
  })
})
