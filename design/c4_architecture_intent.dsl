workspace "EPM / CPM Platform" "Budgeting, Forecasting & Scenario Modelling Platform" {

    model {
        # ===== People =====
        businessUser = person "Business User" "Department planners, FP&A analysts who create budgets, forecasts and scenarios"
        dataEngineer = person "Data Engineer" "Owns complex foundational models and pipelines"
        steward = person "Planning Steward / Admin" "Reviews, approves and promotes scenarios to official Plan"

        # ===== External Systems =====
        enterpriseLake = softwareSystem "Enterprise Data Lake / Mesh" "Trusted Gold data products (Parquet / Iceberg / Delta / DuckLake) on ADLS Gen2" "Existing"
        sourceSystems = softwareSystem "Source Systems" "ERP, HR, CRM, etc." "Existing"
        azureMonitor = softwareSystem "Azure Monitor + Log Analytics" "Observability, metrics, logs and alerts" "Existing"
        azureAD = softwareSystem "Microsoft Entra ID" "Identity and access management" "Existing"

        # ===== EPM Platform =====
        epm = softwareSystem "EPM / CPM Platform" "Self-service Budgeting, Forecasting, Scenario Modelling and Plan Promotion" {

            ui = container "Web UI / Thin Layer" "Business-user facing application for model composition, scenario definition, rule authoring, review workflow and visualisation" "React / TypeScript" {
                tags "UI"
            }

            api = container "Thin Layer API & Orchestration" "Governance, model registry, workflow engine, job submission, promotion logic, rule loading, pre-validation and the Cube schema refresh consumer" "Node.js / Python / .NET" {
                tags "API"
            }

            rules = container "Business Rule Registry & Engine" "Versioned, scoped business rules (allocation, validation, promotion gates). Rules-as-data with lightweight evaluation." "Postgres-backed + Python/Node evaluator" {
                tags "Rules"

                ruleStore = component "Rule Store" "Versioned rule definitions (JSON/YAML), scope (Global/Dept/Cost Centre/Scenario Type), effective dates and audit" "PostgreSQL"
                ruleEngine = component "Rule Evaluation Engine" "Lightweight evaluator invoked by API and Scenario Jobs" "Python / Node"
            }

            cube = container "Semantic Model Layer (Cube Core)" "Governed semantic layer, metrics, dimensions, access control and query entry point. Loads dynamic model schema from the shared cache at boot and reloads on refresh events; promoted models are served from reviewed static YAML." "Cube Core" {
                tags "Semantic"
            }

            valkey = container "Schema Snapshot Cache (Valkey)" "Content-addressed Cube schema snapshots (manifest + generated YAML), promoted-model exclusions and refresh events shared by every API and Cube replica" "Valkey 9 / Azure Cache for Redis (RESP)" {
                tags "Infrastructure"
            }

            olap = container "OLAP Engine (DuckDB)" "Columnar analytical engine for heavy aggregations, driver calculations and scenario compute" "DuckDB + DuckLake" {
                tags "OLAP"
            }

            oltp = container "OLTP / Durable Store" "System of record for catalog, model definitions, scenario metadata, workflow state, audit, allocation rules, business rules and promoted Plans" "PostgreSQL (preferred) or MariaDB" {
                tags "OLTP"
            }

            jobs = container "Ephemeral Scenario Jobs" "Short-lived exclusive compute pods that run scenario calculations in isolation" "Azure Container Apps Jobs / AKS Jobs (DuckDB instances)" {
                tags "Jobs"

                allocationStrategy = component "Cost Allocation Strategy" "Pluggable allocation engine (Strategy pattern). Rule-driven. Runs at scenario execution time." "DuckDB SQL + Python" {
                    tags "Allocation"
                }
                baseCalc = component "Base Scenario Calculator" "Applies drivers, adjustments and core calculations" "DuckDB SQL"
                resultWriter = component "Scenario Result Writer" "Persists allocated facts, rule execution audit trail and status" "DuckDB / Postgres"
                postValidation = component "Post-Calculation Validation" "Runs post-allocation and consistency rules inside the job" "Python + Rule Engine"
            }

            dbt = container "dbt Pipelines (optional / light)" "Versioned transformations for simple business models and any EPM-specific enrichment" "dbt Core" {
                tags "dbt"
            }
        }

        # ===== Relationships - Context level =====
        businessUser -> epm "Creates models, scenarios, rules; reviews & promotes plans"
        dataEngineer -> epm "Publishes complex foundational models and pipelines"
        steward -> epm "Approves and promotes scenarios; manages high-level rules"
        epm -> enterpriseLake "Reads trusted Gold data products"
        sourceSystems -> enterpriseLake "Feed data (existing pipelines)"
        epm -> azureAD "Authenticates users"
        epm -> azureMonitor "Sends logs, metrics and traces"

        # ===== Relationships - Container level =====
        businessUser -> ui "Uses"
        steward -> ui "Uses"
        dataEngineer -> ui "Uses (advanced) + dbt"
        dataEngineer -> cube "Promotes stable generated models to reviewed static YAML (make promote-cube-schema); changes ship by PR and deploy"

        ui -> api "API calls (models, scenarios, jobs, workflow, rules, allocation)"

        # Rules interactions
        api -> rules "Loads applicable rules (by scope & effective date); runs pre-submit validation"
        api -> oltp "Reads/writes catalog, metadata, workflow state, audit, rule definitions"
        rules -> oltp "Persists versioned rule definitions and execution audit"
        rules -> api "Returns validation results and rule sets for job payload"

        api -> jobs "Submits scenario job payloads (includes chosen Allocation Strategy + applicable rule set / rule IDs)"

        # Dynamic schema refresh hooks: API publishes a content-addressed snapshot;
        # every Cube replica reads it on boot and reloads on the refresh event.
        api -> valkey "Publishes the schema manifest, generated YAML and commit/rollback refresh events"
        cube -> valkey "Reads the schema pointer and generated YAML on boot; subscribes to refresh events"
        api -> cube "Verifies the committed snapshot (/meta + one load per cube) before reporting the refresh succeeded"

        api -> dbt "Triggers targeted simple model runs (optional)"

        cube -> olap "Queries analytical data & scenario results (including allocated measures)"
        cube -> oltp "Can also query lighter / reference data directly (hybrid)"

        jobs -> olap "Starts exclusive DuckDB instance"
        jobs -> oltp "Reads base data / writes scenario results, allocation + rule audit & status"
        jobs -> enterpriseLake "Reads Gold tables / Parquet directly when beneficial"
        jobs -> rules "Invokes Rule Evaluation Engine for allocation decisions and post-calculation validation"

        # Internal job flow with rules
        baseCalc -> allocationStrategy "Applies selected Cost Allocation Strategy after base adjustments"
        allocationStrategy -> rules "Consults business rules for drivers, percentages, eligibility, constraints"
        allocationStrategy -> postValidation "Hands off for post-allocation checks"
        postValidation -> rules "Executes consistency and threshold rules"
        postValidation -> resultWriter "Writes allocated facts + rule execution audit trail"

        olap -> enterpriseLake "Direct columnar reads (Parquet / DuckLake)"
        olap -> oltp "Can ATTACH durable store for hybrid queries"

        dbt -> oltp "Materialises simple models (optional path)"
        dbt -> enterpriseLake "Reads source Gold data"

        # ===== Deployment Environment =====
        live = deploymentEnvironment "Azure AKS" {
            deploymentNode "Microsoft Azure" {
                tags "Azure"

                deploymentNode "Resource Group - epm-prod" {

                    deploymentNode "Azure Kubernetes Service (AKS) Cluster" {
                        tags "AKS"

                        deploymentNode "Node Pool - System" {
                            description "UI, rules, API and Cube. API is a single writer while DuckDB is the OLTP store; Cube replicas are stateless and converge on the shared schema version."
                            containerInstance ui
                            containerInstance api
                            containerInstance cube
                            containerInstance rules
                        }

                        deploymentNode "Node Pool - Jobs (spot / autoscale)" {
                            description "Dedicated node pool for ephemeral Scenario Jobs. Scales to zero when idle."
                            containerInstance jobs
                        }

                        deploymentNode "Node Pool - Analytics (optional)" {
                            description "Optional dedicated pool for long-running Cube workers or pre-aggregation builds"
                            containerInstance olap
                        }
                    }

                    deploymentNode "Azure Database for PostgreSQL - Flexible Server" {
                        description "Primary OLTP / Durable Store (catalog, metadata, workflow, business rules, allocation rules, promoted plans)"
                        containerInstance oltp
                    }

                    deploymentNode "Azure Cache for Redis (Valkey-compatible)" {
                        description "Shared schema snapshot cache: dynamic Cube YAML, promoted-model exclusions and refresh events for all API and Cube replicas"
                        containerInstance valkey
                    }

                    deploymentNode "Azure Data Lake Storage Gen2" {
                        description "Enterprise Gold layer + DuckLake / Parquet scenario results"
                        softwareSystemInstance enterpriseLake
                    }

                    deploymentNode "Azure Monitor + Log Analytics" {
                        softwareSystemInstance azureMonitor
                    }

                    deploymentNode "Microsoft Entra ID" {
                        softwareSystemInstance azureAD
                    }
                }
            }
        }
    }

    views {
        systemContext epm "SystemContext" {
            include *
            autoLayout
            title "EPM / CPM Platform - System Context"
        }

        container epm "Containers" {
            include *
            autoLayout
            title "EPM / CPM Platform - Container Diagram (with Business Rules)"
        }

        component jobs "ScenarioJobsComponents" {
            include *
            autoLayout
            title "Ephemeral Scenario Jobs - Component Diagram (Allocation + Rules)"
        }

        component rules "RulesComponents" {
            include *
            autoLayout
            title "Business Rule Registry & Engine - Component Diagram"
        }

        deployment epm "Azure AKS" "AzureAKSDeployment" {
            include *
            autoLayout
            title "EPM / CPM Platform - Azure AKS Deployment View"
        }

        styles {
            element "Person" {
                shape person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            element "UI" {
                background #85bbf0
                color #000000
            }
            element "Semantic" {
                background #5d8aa8
                color #ffffff
            }
            element "OLAP" {
                background #2e8b57
                color #ffffff
            }
            element "OLTP" {
                background #b8860b
                color #ffffff
            }
            element "Jobs" {
                background #cd5c5c
                color #ffffff
            }
            element "Allocation" {
                background #ff7f50
                color #ffffff
            }
            element "Rules" {
                background #6f42c1
                color #ffffff
            }
            element "Existing" {
                background #999999
                color #ffffff
            }
            element "dbt" {
                background #ff69b4
                color #ffffff
            }
            element "Infrastructure" {
                background #607d8b
                color #ffffff
            }
        }
    }
}
