# Product Requirements Document

## EPM / CPM Platform

**Budgeting, Forecasting & Scenario Modelling**

| Field | Value |
|-------|-------|
| Document type | Product Requirements Document (PRD) |
| Audience | Product, Architecture, Engineering, FP&A stakeholders |
| Language | Simple technical English |
| Status | Draft for review |
| Format | Markdown |

---

## 1. Purpose

This document describes the business capabilities, features, functional requirements and non-functional requirements for an Enterprise Performance Management (EPM) / Corporate Performance Management (CPM) platform.

The platform focuses on **Budgeting and Forecasting**. It lets business users build data models, run scenarios, apply cost allocations, and promote approved scenarios into an official plan through a review workflow.

The platform is designed as a **thin layer** on top of open tools (Cube Core, DuckDB, PostgreSQL, dbt). It is intended for deployment on Azure while remaining portable.

---

## 2. Goals and Success Criteria

### 2.1 Goals

- Enable department planners and FP&A teams to create and compare budget and forecast scenarios without heavy dependence on data engineers for every change.
- Support rule-driven cost allocation inside scenario execution.
- Provide a clear path from scenario to official plan with review and approval.
- Keep the platform thin: reuse Cube, DuckDB, PostgreSQL and dbt instead of building a full proprietary stack.
- Deploy primarily on Azure (AKS, ADLS, Azure Database for PostgreSQL) while preserving portability.

### 2.2 Success Criteria (high level)

- Business users can define simple data models and scenarios through the UI.
- Scenario jobs run in isolation and scale with demand.
- Cost allocation and validation rules are configurable and versioned.
- Department and cost-centre access control is enforced end-to-end.
- Approved scenarios can be promoted to the official plan with an audit trail.

---

## 3. Users and Roles

| Role | Description |
|------|-------------|
| **Business User** | Department planner or FP&A analyst. Creates models, scenarios, runs allocations, views results. |
| **Planning Steward / Admin** | Reviews scenarios, approves promotions to the official plan, manages higher-level rules and access. |
| **Data Engineer** | Owns complex foundational data models and pipelines. Supports simple models created by business users when needed. |

---

## 4. Business Capabilities

### 4.1 Data Modelling (Business-User Driven)

Business users can define and compose simple data models (dimensions, measures, basic facts) through the Thin Layer. Complex foundational models remain under Data Engineering ownership. Simple models can optionally be backed by targeted dbt runs.

### 4.2 Scenario Modelling

Users create budget and forecast scenarios from a base plan or actuals. They apply drivers, adjustments and assumptions. Each scenario runs as an isolated job so concurrent work does not conflict.

### 4.3 Cost Allocation

Cost allocation runs at scenario execution time. Allocation logic is pluggable (Strategy pattern) and driven by business rules. Supported styles include headcount, revenue, usage, fixed percentage and custom rules.

### 4.4 Business Rules

Versioned business rules cover allocation logic, pre-submit validation, post-calculation checks and promotion gates. Rules are stored as data and evaluated by a lightweight engine.

### 4.5 Scenario Promotion and Review Workflow

Completed scenarios can be submitted for review. Stewards approve or reject. Approved scenarios can be promoted into the official plan. Full audit trail is kept.

### 4.6 Governed Querying and Reporting

Cube Core acts as the semantic layer and main query entry point. Users explore actuals, plans, scenarios and allocated results through a consistent metrics layer with access control.

### 4.7 Multi-Department Planning

Different departments plan on top of the same platform. Access is scoped by department and cost centre. Cross-department visibility is controlled by role.

---

## 5. Features

### 5.1 Thin Layer UI

- Model browser and simple model composer (dimensions, measures, basic joins)
- Scenario definition and driver entry screens
- Job status monitoring (Queued, Running, Completed, Failed)
- Scenario comparison and variance views
- Rule authoring and version history (for authorised users)
- Review and promotion screens for stewards
- Department / cost-centre scoped navigation

### 5.2 Thin Layer API and Orchestration

- Model and scenario registry
- Job submission and status tracking
- Pre-submit rule validation
- Promotion workflow engine
- Integration with Cube for schema refresh when models change

### 5.3 Semantic Layer (Cube Core)

- Cubes, views and measures for actuals, plan and scenarios
- Parameterised or dynamic exposure of scenario results
- Access policies aligned with department and cost centre
- Support for pre-aggregations where useful

### 5.4 Scenario Execution (Ephemeral Jobs)

- Exclusive DuckDB instance per scenario job
- Base calculation + Cost Allocation Strategy + post-validation
- Graceful start and shutdown on Azure AKS / Container Apps Jobs
- Write-back of results and audit trail to the durable store

### 5.5 Business Rule Registry and Engine

- Versioned rule definitions with scope (global, department, cost centre, scenario type)
- Effective dating and audit
- Evaluation at pre-submit, allocation and post-calculation points
- Rules-as-data (JSON/YAML or simple structured form)

### 5.6 Durable Store and Catalog

- PostgreSQL (preferred) or MariaDB as system of record
- Stores models, scenarios, workflow state, rules, allocation metadata and promoted plans
- Supports hybrid query from Cube and DuckDB when needed

### 5.7 Optional Light dbt Support

- Targeted runs for simple business-user models
- Complex facts and datasets remain Data Engineering owned

---

## 6. Functional Requirements

### 6.1 Data Modelling

| ID | Requirement |
|----|-------------|
| FR-DM-01 | Business users can create, edit and version simple dimensions and measures through the UI. |
| FR-DM-02 | Changes go through draft → validation → publish. Drafts are not visible to normal users until published. |
| FR-DM-03 | Published model changes become available to Cube and to new scenarios without breaking running scenarios. |
| FR-DM-04 | Complex foundational models are supplied by Data Engineering and appear as reusable building blocks. |

### 6.2 Scenario Modelling and Execution

| ID | Requirement |
|----|-------------|
| FR-SC-01 | Users can create a scenario from a base plan or actuals and apply drivers and adjustments. |
| FR-SC-02 | Scenario submission creates an asynchronous job that runs in an exclusive compute instance. |
| FR-SC-03 | Job status (Queued, Running, Completed, Failed) is visible in the UI and updated in near real time. |
| FR-SC-04 | Scenario results are stored with scenario identity and can be queried through Cube. |
| FR-SC-05 | Users can compare multiple scenarios and view variances against plan or actuals. |

### 6.3 Cost Allocation

| ID | Requirement |
|----|-------------|
| FR-CA-01 | Cost allocation runs inside the scenario job after base adjustments. |
| FR-CA-02 | Allocation method is selectable (headcount, revenue, usage, fixed %, custom) and driven by business rules. |
| FR-CA-03 | Allocation inputs and outputs are auditable (which rule, which drivers, resulting amounts). |
| FR-CA-04 | Post-allocation validation can enforce that allocated totals match source pools within defined tolerance. |

### 6.4 Business Rules

| ID | Requirement |
|----|-------------|
| FR-BR-01 | Rules are versioned and scoped (global, department, cost centre, scenario type). |
| FR-BR-02 | Pre-submit validation rules can accept, warn or reject a scenario before the job starts. |
| FR-BR-03 | Allocation and post-calculation rules are evaluated inside the scenario job. |
| FR-BR-04 | Promotion rules can require specific approvers or thresholds before a scenario becomes the official plan. |
| FR-BR-05 | Rule changes are audited (who, when, what changed). |

### 6.5 Promotion and Workflow

| ID | Requirement |
|----|-------------|
| FR-WF-01 | A completed scenario can be submitted for review. |
| FR-WF-02 | Stewards can approve, reject or request changes. |
| FR-WF-03 | On approval, the scenario (or selected parts) can be promoted to the official plan. |
| FR-WF-04 | Full history of submissions, decisions and promotions is retained. |

### 6.6 Access Control

| ID | Requirement |
|----|-------------|
| FR-AC-01 | Users authenticate via Microsoft Entra ID (or equivalent corporate identity). |
| FR-AC-02 | Data and actions are restricted by department and cost centre membership. |
| FR-AC-03 | UI only shows navigation, scenarios and data the user is allowed to access. |
| FR-AC-04 | API and Cube queries enforce the same scope; unauthorised data is never returned. |

### 6.7 Query and Reporting

| ID | Requirement |
|----|-------------|
| FR-QR-01 | Cube is the primary entry point for analytical queries. |
| FR-QR-02 | Users can query actuals, plan, scenarios and allocated results using governed metrics. |
| FR-QR-03 | Scenario results appear as queryable constructs (parameterised or dynamic) after job completion. |

---

## 7. Non-Functional Requirements

### 7.1 Performance

| ID | Requirement |
|----|-------------|
| NFR-P-01 | Scenario submission is accepted and enqueued within a target time (placeholder: `{{enqueue_ms}}` ms). |
| NFR-P-02 | 95th percentile end-to-end scenario completion time meets the agreed target (placeholder: `{{scenario_p95_sec}}` seconds) under expected concurrent load. |
| NFR-P-03 | Viewing scenario and budget screens returns initial results within the agreed target (placeholder: `{{view_ttfb_ms}}` / `{{view_p95_ms}}` ms). |
| NFR-P-04 | UI status updates for jobs appear within the agreed refresh target (placeholder: `{{ui_refresh_ms}}` ms). |

### 7.2 Scalability

| ID | Requirement |
|----|-------------|
| NFR-S-01 | The platform supports concurrent scenario submissions across departments (placeholder: `{{N_cross_dept}}` users) and within a department (placeholder: `{{N_intra_dept}}` users). |
| NFR-S-02 | Ephemeral scenario jobs scale out on a dedicated node pool and scale to zero when idle. |
| NFR-S-03 | Concurrent viewers of budgets and scenarios are supported up to the agreed level (placeholder: `{{N_viewers}}`). |

### 7.3 Resiliency

| ID | Requirement |
|----|-------------|
| NFR-R-01 | Scenario jobs shut down gracefully on cancellation, node eviction or failure. Final status is written to the durable store. |
| NFR-R-02 | Graceful shutdown completes within the agreed time (placeholder: `{{shutdown_sec}}` seconds). |
| NFR-R-03 | No orphaned exclusive compute locks remain after job termination. |
| NFR-R-04 | Failed jobs can be retried according to a defined policy (placeholder: `{{max_retries}}`). |

### 7.4 Modifiability

| ID | Requirement |
|----|-------------|
| NFR-M-01 | New or changed dimensions and measures are versioned. Running scenarios keep the version they started with. |
| NFR-M-02 | Publishing a model change makes it visible in the UI and queryable within the agreed time (placeholder: `{{publish_propagate_sec}}` seconds). |
| NFR-M-03 | A new Cube (domain entity) can be introduced through the governed path and becomes queryable without code deployment of the core platform. |
| NFR-M-04 | Validation feedback for model changes is returned quickly (placeholder: `{{validation_ms}}` ms). |

### 7.5 Security

| ID | Requirement |
|----|-------------|
| NFR-SEC-01 | All users authenticate through the corporate identity provider (Microsoft Entra ID). |
| NFR-SEC-02 | Authorization is enforced by department and cost centre for both UI and API/Cube access. |
| NFR-SEC-03 | Authorization decisions complete within the agreed time (placeholder: `{{authz_ms}}` ms). |
| NFR-SEC-04 | Access attempts (success and failure) are auditable. |
| NFR-SEC-05 | Tokens are validated on every API request (placeholder target: `{{token_validation_ms}}` ms). |

### 7.6 Operability and Portability

| ID | Requirement |
|----|-------------|
| NFR-O-01 | Primary deployment target is Azure (AKS, Azure Database for PostgreSQL, ADLS Gen2). |
| NFR-O-02 | Core compute and storage choices (DuckDB, PostgreSQL, open table formats, Cube) support movement to other clouds or on-prem with limited rework. |
| NFR-O-03 | Logs, metrics and traces are emitted to the platform observability stack (e.g. Azure Monitor). |
| NFR-O-04 | The platform remains a thin layer; heavy lifting stays in Cube, DuckDB, PostgreSQL and dbt. |

---

## 8. Sample / Open Datasets for Feature Verification

The following open or synthetic datasets can be used to bootstrap the platform and verify features, functionality and end-to-end flows. They are not production data; they are suitable for demos, integration tests and early validation of modelling, scenarios, allocation and variance analysis.

### 8.1 Recommended Datasets

| Dataset | Source | What it provides | Useful for verifying |
|---------|--------|------------------|----------------------|
| **Budget vs Actual Financial Dataset** | [Kaggle – kennathalexanderroy](https://www.kaggle.com/datasets/kennathalexanderroy/budget-vs-actual-financial-dataset) | ~10k rows, 3 years, multiple departments (Sales, HR, IT, Finance, Operations, Marketing), regions, budget amount vs actual amount | Variance analysis, department-scoped planning, Cube measures, scenario comparison |
| **FP&A Variance Analysis Model** | [Kaggle – ameernassar](https://www.kaggle.com/datasets/ameernassar/fp-and-a-variance-analysis) | Monthly budget vs actual across 7 departments; synthetic but realistic FP&A structure | Department variance views, forecast error trends, UI reporting screens |
| **Mindweave SME-Sim (sample)** | [GitHub – MindweaveTech/sme-sim-sample](https://github.com/MindweaveTech/sme-sim-sample) / [Hugging Face](https://huggingface.co/datasets/mindweave/australian-sme-business-dataset) | Relational SME business data with double-entry accounting, chart of accounts, departments, journal entries, payroll (AU/US/UK variants). Free sample ~2.8k rows; fuller packs available | Multi-table modelling, allocation drivers (e.g. headcount, cost centres), governed semantic layer, realistic fact/dimension shape |
| **Marketing Budget and Actual Sales** | [Kaggle – jacouchs](https://www.kaggle.com/datasets/jacouchs/marketing-budget-and-actual-sales-dataset) | Simple marketing budget vs actual sales pairs | Driver-based forecasting experiments, lightweight regression-style scenarios (optional) |

### 8.2 How to use them in verification

1. **Land as Gold-like inputs**  
   Load the chosen dataset(s) into ADLS / DuckLake or into the durable store as curated “actuals” and “budget” tables. Treat them as the enterprise Gold layer for the demo environment.

2. **Data Modelling**  
   Build simple dimensions (Department, Region, Account/Category, Period) and measures (Budget Amount, Actual Amount, Variance) through the Thin Layer. Confirm draft → validate → publish and Cube visibility.

3. **Scenario Modelling**  
   Create scenarios that adjust drivers (e.g. growth %, headcount, marketing spend). Run exclusive Scenario Jobs and confirm status transitions and result write-back.

4. **Cost Allocation**  
   Use department or headcount-style drivers from SME-Sim (or synthetic headcount columns) to exercise Allocation Strategies and post-allocation validation rules.

5. **Variance and comparison**  
   Use Budget vs Actual datasets to verify scenario comparison screens, Cube queries and department-scoped access.

6. **Rules and workflow**  
   Define simple pre-submit and promotion rules (e.g. “variance > X% requires steward approval”) and walk a scenario through review and promotion.

7. **Access control**  
   Map synthetic departments to test users / Entra groups and confirm UI and API scope enforcement.

### 8.3 Notes

- Prefer **synthetic / openly licensed** data for public demos and CI. Do not load real customer financials into shared or non-production environments without proper controls.
- SME-Sim is especially useful when you need a richer relational model (chart of accounts, journals, departments) rather than a single flat budget-vs-actual file.
- Numeric performance targets remain placeholders; these datasets are for **functional and feature verification**, not for load testing at production scale.

---

## 9. Out of Scope (MVP)

- Full replacement of enterprise data engineering pipelines and the enterprise lakehouse.
- Heavy statistical or machine-learning forecasting engines (can be added later as optional strategies).
- Pixel-perfect financial consolidations and statutory reporting.
- Real-time collaborative multi-user editing of the same scenario cells (scenarios are job-based).
- Building a full proprietary rules BRMS; the MVP uses a thin rules-as-data engine.

---

## 10. Assumptions and Dependencies

- A trusted enterprise Gold layer (or equivalent curated data) is available for the platform to read. For early verification, the open datasets in Section 8 may stand in for Gold.
- Microsoft Entra ID (or compatible identity provider) is available for authentication.
- Azure subscription and networking are available for AKS, PostgreSQL and ADLS (or equivalent in another environment).
- Business users who author simple models and rules receive basic training on the Thin Layer.
- Data Engineering continues to own complex foundational models and data quality for core facts.

---

## 11. Open Items / Placeholders

Concrete numeric targets for performance, scalability and latency are captured as placeholders (for example `{{scenario_p95_sec}}`, `{{N_cross_dept}}`, `{{authz_ms}}`). These should be filled from capacity planning and quality-attribute workshops and then reflected in the Quality Attribute Scenario catalogue (`EPM_Quality_Attribute_Scenarios.xlsx`).

---

*End of Document*
