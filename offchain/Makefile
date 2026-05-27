# DIA Cardano Oracle — operator shortcuts.
# All targets delegate to docker compose running from offchain/feeder/.

COMPOSE := docker compose -f feeder/docker-compose.yml --project-directory feeder
UID ?= $(shell id -u)
GID ?= $(shell id -g)
export UID
export GID

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F: '{printf "  %-22s %s\n", $$1, $$NF}'

.PHONY: build
build: ## Build the unified feeder + CLI image
	$(COMPOSE) --profile sqlite build

.PHONY: up
up: ## Start the feeder daemon (sqlite profile)
	$(COMPOSE) --profile sqlite up -d

.PHONY: up-postgres
up-postgres: ## Start the feeder daemon (postgres profile)
	$(COMPOSE) --profile postgres up -d

.PHONY: up-monitoring
up-monitoring: ## Start feeder + Prometheus + Grafana
	$(COMPOSE) --profile sqlite --profile monitoring up -d

.PHONY: down
down: ## Stop everything
	$(COMPOSE) down

.PHONY: logs
logs: ## Tail feeder logs
	$(COMPOSE) logs -f feeder-sqlite

.PHONY: cli
cli: ## Run a CLI command. Usage: make cli CMD="protocol"
	$(COMPOSE) --profile cli run --rm cli $(CMD)

.PHONY: bootstrap
bootstrap: ## End-to-end protocol bootstrap (one-shot)
	$(COMPOSE) --profile cli run --rm cli wallet:create
	$(COMPOSE) --profile cli run --rm cli protocol:init
	$(COMPOSE) --profile cli run --rm cli config:parameterize
	$(COMPOSE) --profile cli run --rm cli config:reference-scripts
	$(COMPOSE) --profile cli run --rm cli config:bootstrap
	$(COMPOSE) --profile cli run --rm cli client:init
	$(COMPOSE) --profile cli run --rm cli receiver:bootstrap
	$(COMPOSE) --profile cli run --rm cli receiver:parameterize
	$(COMPOSE) --profile cli run --rm cli reference-scripts:publish-client
