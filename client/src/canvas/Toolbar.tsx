export function Toolbar() {
  return (
    <header className="ed-head">
      <span className="logo">
        <span className="logo-mark">E</span>
        ERD Editor
      </span>
      <div className="tb-sep" />
      <button type="button" className="btn tb" title="테이블 추가" disabled>
        <svg width="14" height="14" viewBox="0 0 16 16">
          <rect
            x="1.5"
            y="2"
            width="13"
            height="12"
            rx="2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        테이블
      </button>
    </header>
  )
}
