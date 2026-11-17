import { assertSingleYjs } from './singleYjs'

// 봇을 띄우기 전에 yjs가 한 벌인지 먼저 확인, 두 벌이면 편집이 깨지므로 바로 멈춤
assertSingleYjs()
console.log('yjs 단일 로드 확인')
