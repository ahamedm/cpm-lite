SHELL := /bin/bash
CUBE_DIR := cube
API_DIR := apps/api
WEB_DIR := apps/web
CONTRACTS_DIR := packages/contracts
NPM ?= npm

.PHONY: setup data cube verify lint-api migrate-api seed-api api build-api typecheck-api verify-api web build-web typecheck-web test clean

setup:
	$(NPM) --prefix $(CUBE_DIR) install
	$(NPM) --prefix $(CONTRACTS_DIR) install
	$(NPM) --prefix $(API_DIR) install
	$(NPM) --prefix $(WEB_DIR) install

data:
	$(NPM) --prefix $(CUBE_DIR) run load

cube:
	$(NPM) --prefix $(CUBE_DIR) run dev

verify:
	@test -f data/cpm_lite.duckdb || (echo "Missing data/cpm_lite.duckdb. Run 'make data' first."; exit 1)
	$(NPM) --prefix $(CUBE_DIR) run verify

lint-api:
	$(NPM) --prefix $(CONTRACTS_DIR) run lint

migrate-api:
	$(NPM) --prefix $(API_DIR) run migrate

seed-api:
	$(NPM) --prefix $(API_DIR) run seed

api:
	$(NPM) --prefix $(API_DIR) run dev

build-api:
	$(NPM) --prefix $(API_DIR) run build

typecheck-api:
	$(NPM) --prefix $(API_DIR) run typecheck

verify-api:
	$(NPM) --prefix $(API_DIR) run test

web:
	$(NPM) --prefix $(WEB_DIR) run dev

build-web:
	$(NPM) --prefix $(WEB_DIR) run build

typecheck-web:
	$(NPM) --prefix $(WEB_DIR) run typecheck

test: verify lint-api typecheck-api verify-api build-web

clean:
	rm -f data/cpm_lite.duckdb data/cpm_lite.duckdb.wal data/cpm_lite_preview.duckdb data/cpm_lite_preview.duckdb.wal data/cpm_lite_oltp.duckdb data/cpm_lite_oltp.duckdb.wal
	rm -rf data/staging data/.duckdb-extensions cube/.cubestore apps/web/dist
