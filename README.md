# erd-editor
CRDT 기반 고가용성 실시간 협업 ERD 편집기 (차세대분산시스템 Team 01)


## 폴더 구조

- `client/` : ERD 편집기
- `server/` : 편집 서버
- `worker/` : 스냅샷 워커
- `loadtest/` : 부하 봇, 수렴 검증
- `deploy/` : Dockerfile, kustomize, kind
- `monitoring/` : Prometheus, Grafana
- `docs/` : contracts.md, ADR



## 작업 규칙
- main에 직접 push 불가
- `feat/기능명`, `fix/버그명` 브랜치에서 작업 후 PR
- 1명 승인 후 squash merge


## 실행 방법
준비 중


