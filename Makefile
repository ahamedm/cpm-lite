SHELL := /bin/bash
CUBE_DIR := cube
API_DIR := apps/api
WEB_DIR := apps/web
CONTRACTS_DIR := packages/contracts
NPM ?= npm
NODE ?= node

.PHONY: setup data cube verify test-cube lint-api migrate-api seed-api promote-cube-schema api build-api typecheck-api verify-api web build-web typecheck-web audit test clean

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

test-cube:
	$(NPM) --prefix $(CUBE_DIR) test

lint-api:
	$(NPM) --prefix $(CONTRACTS_DIR) run lint

migrate-api:
	$(NPM) --prefix $(API_DIR) run migrate

seed-api:
	$(NPM) --prefix $(API_DIR) run seed

promote-cube-schema:
	$(NPM) --prefix $(API_DIR) run promote-cube-schema

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

audit:
	$(NODE) scripts/check-dependencies.mjs

test: verify test-cube lint-api typecheck-api verify-api build-web

clean:
	rm -f data/cpm_lite.duckdb data/cpm_lite.duckdb.wal data/cpm_lite_preview.duckdb data/cpm_lite_preview.duckdb.wal data/cpm_lite_oltp.duckdb data/cpm_lite_oltp.duckdb.wal
	rm -rf data/staging data/.duckdb-extensions cube/.cubestore apps/web/dist
