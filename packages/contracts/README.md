# CPM Lite API contracts

Contract-first OpenAPI definitions for the Thin Orchestrator API. The committed
YAML is the source of truth; implementation code must conform to it.

- `openapi/thin-orchestrator.v1.yaml` — HTTP surface
- `openapi/schemas/*.yaml` — domain schemas

This is a review draft. No API implementation exists yet.

```bash
npm install
npm run lint
npm run bundle
```

Lint is run by `make lint-api` from the repository root.
