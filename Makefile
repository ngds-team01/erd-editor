CLUSTER_NAME := erd
KIND_CONFIG  := deploy/kind/cluster.yaml
CONTEXT      := kind-$(CLUSTER_NAME)

.PHONY: up down status

up:
	@kind get clusters 2>/dev/null | grep -qx $(CLUSTER_NAME) || kind create cluster --config $(KIND_CONFIG)
	kubectl --context $(CONTEXT) wait --for=condition=Ready nodes --all --timeout=180s
	kubectl --context $(CONTEXT) get nodes

down:
	kind delete cluster --name $(CLUSTER_NAME)

status:
	kubectl --context $(CONTEXT) get nodes -o wide
	kubectl --context $(CONTEXT) get pods -A
