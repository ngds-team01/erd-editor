import { useState } from 'react'
import type { ComponentProps, KeyboardEvent } from 'react'

type TextFieldProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: string
  onCommit: (value: string) => void
}

//TextFieldProps에서 value, onCommit를 제외하고는 하나의 객체로 결합
export function TextField({ value, onCommit, ...inputProps }: TextFieldProps) {
  // draft는 Y.Doc에는 작성되지 않은, 편집 중인 임시 값
  const [draft, setDraft] = useState<string | null>(null)

  //편집한 내역이 있고 해당 내역이 변경되었을 때 반영 - commit
  function commit() {
    if (draft !== null && draft !== value) {
      onCommit(draft)
    }
    setDraft(null)
  }

  //키 처리 함수
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 키 입력 중인 경우 별도 처리하지 않음 
    if (event.nativeEvent.isComposing) {
      return
    }
    //Enter 입력 시 작성 종료로 간주 - focus 해제 - onBlur 통해 변경분 commit
    if (event.key === 'Enter') {
      event.currentTarget.blur()
    //ESC는 변경분 적용을 취소 요청하는 키
    } else if (event.key === 'Escape') {
      setDraft(null)
    }
  }

  //변경분을 합쳐 화면에 출력하기 위해 return
  return (
    <input
      type="text"
      {...inputProps}
      //편집 중인 경우 draft 반영, 아니라도 타인의 변경분 바로 표시
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  )
}
