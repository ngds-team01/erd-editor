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

### 로컬 클러스터 (kind)

**1. 설치** (Docker, kind v0.33.0, kubectl, make)
```bash
# kind 설치
curl -Lo kind https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64
sudo install kind /usr/local/bin/kind && rm kind
# kubectl 설치
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install kubectl /usr/local/bin/kubectl && rm kubectl
# make 설치
sudo apt-get install -y make
```

**2. 실행** (저장소 최상위 폴더에서)
```bash
git clone https://github.com/ngds-team01/erd-editor.git && cd erd-editor
make up      # 클러스터 생성 (노드 4개, Kubernetes v1.37.0)
make status  # 상태 확인
make down    # 삭제
```

**WSL2 (Windows)**
- Docker Desktop 설치 → Settings → Resources → WSL integration에서 Ubuntu 켜기
- 접속: `localhost:8088`

**VM (Ubuntu 22.04 이상)**
- CPU 4코어, 메모리 8GB 이상, 네트워크 브리지 모드
- 접속: `<VM IP>:8088`


