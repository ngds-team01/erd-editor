CLUSTER_NAME := erd
KIND_CONFIG  := deploy/kind/cluster.yaml
CONTEXT      := kind-$(CLUSTER_NAME)
SERVER_IMAGE := crdt-server:dev

.PHONY: up down status server deploy reset

up:
	@kind get clusters 2>/dev/null | grep -qx $(CLUSTER_NAME) || kind create cluster --config $(KIND_CONFIG)
	kubectl --context $(CONTEXT) wait --for=condition=Ready nodes --all --timeout=180s
	kubectl --context $(CONTEXT) get nodes

down:
	kind delete cluster --name $(CLUSTER_NAME)

status:
	kubectl --context $(CONTEXT) get nodes -o wide
	kubectl --context $(CONTEXT) get pods -A

server:
	docker build -t $(SERVER_IMAGE) ./server
	kind load docker-image $(SERVER_IMAGE) --name $(CLUSTER_NAME)
	@kubectl --context $(CONTEXT) get deployment editor >/dev/null 2>&1 && kubectl --context $(CONTEXT) rollout restart deployment/editor || true

deploy:
	kubectl --context $(CONTEXT) apply -k deploy/k8s

reset:
	kubectl --context $(CONTEXT) delete -k deploy/k8s --ignore-not-found
	kubectl --context $(CONTEXT) delete pvc data-redis-0 data-minio-0 --ignore-not-found