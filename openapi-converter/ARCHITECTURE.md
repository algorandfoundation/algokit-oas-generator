# Architecture

This document describes the logical architecture and design of the Algorand OpenAPI Converter, highlighting system structure, data flow and patterns.

## Overview

The converter is a data transformation pipeline that enriches Algorand API specifications with metadata for multi-language code generation. It operates in five stages: **Fetch** → **Convert** → **Transform** → **Validate** → **Output**.

## System Architecture

The converter employs a layered architecture where each layer has distinct responsibilities and clear boundaries. The system is organized into four distinct layers that work together to transform raw API specifications into enhanced, validated outputs.

```mermaid
graph TB
    CLI[CLI Entry Point] --> Orchestrator[Spec Orchestrator]
    Orchestrator --> Algod[Algod Pipeline]
    Orchestrator --> Indexer[Indexer Pipeline]
    Orchestrator --> KMD[KMD Pipeline]
    
    Algod --> Processor[OpenAPI Processor]
    Indexer --> Processor
    KMD --> Processor
    
    Processor --> Output[Validated Specs]
    
    style CLI fill:#e1f5ff
    style Orchestrator fill:#fff4e1
    style Processor fill:#ffe1f5
    style Output fill:#e1ffe1
```

The CLI Layer handles argument parsing and determines which pipeline to execute. The Orchestration Layer coordinates version fetching from GitHub and routes work to the appropriate API pipeline. The Processing Layer contains the core transformation engine that applies all modifications to the specifications. Finally, the Output Layer validates the transformed specs and writes them to disk.

```mermaid
graph LR
    subgraph "Input Layer"
        A[GitHub API] --> B[Spec URLs]
    end
    
    subgraph "Processing Core"
        B --> C[Fetch & Parse]
        C --> D[Format Conversion]
        D --> E[Transformation Pipeline]
    end
    
    subgraph "Output Layer"
        E --> F[Validation]
        F --> G[Enhanced Specs]
    end
    
    style A fill:#e3f2fd
    style E fill:#fff3e0
    style G fill:#e8f5e9
```

The Input Layer retrieves specifications from GitHub repositories and resolves them to concrete URLs. The Processing Core handles the heavy lifting of fetching, parsing, format conversion, and transformation. The Output Layer ensures quality through validation before persisting the enhanced specifications to disk.

## Data Flow

Data flows through the system in a series of stages, from user input to final output. The processing pipeline is designed to be linear and deterministic, ensuring that each API specification passes through the same sequence of transformations.

### Processing Pipeline

The following diagram illustrates the complete flow from user command to enhanced specification output, including decision points for version fetching and API selection.

```mermaid
flowchart TD
    Start([User Command]) --> Parse[Parse CLI Args]
    Parse --> FetchVersion{Fetch Latest<br/>Version?}
    
    FetchVersion -->|Yes| GitHub[Query GitHub API]
    FetchVersion -->|No| Version[Use Default]
    GitHub --> Version
    
    Version --> SelectAPI{Select API}
    SelectAPI -->|Algod| ConfigA[Load Algod Config]
    SelectAPI -->|Indexer| ConfigI[Load Indexer Config]
    SelectAPI -->|KMD| ConfigK[Load KMD Config]
    
    ConfigA --> Process[Process Pipeline]
    ConfigI --> Process
    ConfigK --> Process
    
    Process --> Fetch[1. Fetch Spec]
    Fetch --> Convert[2. Convert OAS2→OAS3]
    Convert --> Transform[3. Apply Transformations]
    Transform --> Validate[4. Validate]
    Validate --> Write[5. Write Output]
    Write --> End([Enhanced Spec])
    
    style Start fill:#e1f5ff
    style Process fill:#fff4e1
    style Transform fill:#ffe1f5
    style End fill:#e1ffe1
```

### Transformation Pipeline Architecture

Once a specification reaches the transformation stage, it passes through a series of sequential modifications. Each transformation builds upon the previous ones, progressively enriching the specification with metadata and corrections.

```mermaid
flowchart LR
    Input[OpenAPI 3.0 Spec] --> T1[Fix Descriptions]
    T1 --> T2[Fix Known Bugs]
    T2 --> T3[Add Type Metadata]
    T3 --> T4[Transform Fields]
    T4 --> T5[Configure Endpoints]
    T5 --> Output[Enhanced Spec]
    
    style Input fill:#e3f2fd
    style T3 fill:#fff3e0
    style Output fill:#e8f5e9
```

Transformations fall into five categories. Compliance fixes address missing descriptions and schema errors required by OpenAPI 3.0. Type enrichment adds metadata like BigInt markers and binary data annotations. Field corrections adjust required/optional declarations and add validation constraints. Endpoint configuration enforces format requirements, specifying whether endpoints use JSON or msgpack. API-specific transformations handle unique requirements of individual APIs.

## Design Principles

### 1. Pipeline-Based Architecture

Each transformation operates as an independent stage that receives the full specification, applies specific modifications, reports the number of changes made, and passes the result to the next stage. This approach makes it easy to add or remove transformations, provides clear execution order, enables observation at each stage, and allows testing transformations in isolation.

### 2. Configuration-Driven Behavior

```mermaid
graph TD
    A[ProcessingConfig] --> B[Vendor Extension Rules]
    A --> C[Field Transformation Rules]
    A --> D[Endpoint Format Rules]
    A --> E[API-Specific Rules]
    
    B --> P[Processor]
    C --> P
    D --> P
    E --> P
    
    P --> O[Output Spec]
    
    style A fill:#e1f5ff
    style P fill:#ffe1f5
```

Each API (Algod, Indexer, KMD) has unique characteristics that require different transformations. Rather than embedding conditional logic throughout the codebase to handle these differences, the architecture uses declarative configuration objects. Each API defines its requirements through a configuration structure that specifies which transformations to apply, what vendor extensions to add, and which fields need adjustment. This separates the "what" (transformation rules) from the "how" (transformation implementation), making the system more maintainable and allowing new APIs to be added without modifying core transformation logic.

### 3. Recursive Tree Traversal

Transformations use depth-first traversal to find and modify target nodes regardless of their location in the spec tree. The pattern checks each node for match conditions, applies the transformation if matched, recursively processes all child nodes, and returns an aggregate count of modifications. This works with any spec structure without requiring upfront knowledge of the schema.

### 4. Fail-Fast Validation

```mermaid
sequenceDiagram
    participant P as Processor
    participant T as Transformations
    participant V as Validator
    participant F as File System
    
    P->>T: Apply all transformations
    T->>V: Send transformed spec
    V->>V: Validate against OpenAPI 3.0
    alt Valid
        V->>F: Write to disk
    else Invalid
        V->>P: Throw error + details
        P->>P: Halt execution
    end
```

Ensures no invalid specs are ever written to disk.

## Transformation Strategy

### Three-Tier Transformation Model

```mermaid
graph TD
    subgraph "Tier 1: Universal Fixes"
        T1[Missing Descriptions]
        T2[Known Bugs]
    end
    
    subgraph "Tier 2: Configurable Transforms"
        T3[Vendor Extensions]
        T4[Field Transforms]
        T5[Required Fields]
    end
    
    subgraph "Tier 3: API-Specific"
        T6[KMD Prefix Stripping]
        T7[Endpoint Format Rules]
    end
    
    Input[Spec] --> T1
    T1 --> T2
    T2 --> T3
    T3 --> T4
    T4 --> T5
    T5 --> T6
    T6 --> T7
    T7 --> Output[Enhanced]
    
    style Input fill:#e3f2fd
    style Output fill:#e8f5e9
```

The three tiers represent different levels of specificity. Tier 1 transformations apply universally to all specs without configuration. Tier 2 transformations are driven by per-API configuration, allowing customization for different needs. Tier 3 transformations are conditional, executing only for specific APIs when required.

## Extension Points

The architecture supports extension at multiple levels:

```mermaid
graph LR
    A[New Transform Type] --> B[Add Config Interface]
    B --> C[Implement Transform]
    C --> D[Add to Pipeline]
    
    E[New API Support] --> F[Create Config]
    F --> G[Add Processing Function]
    G --> H[Update CLI]
    
    I[Custom Validation] --> J[Add Validator]
    J --> K[Insert in Pipeline]
    
    style A fill:#e1f5ff
    style E fill:#fff4e1
    style I fill:#ffe1f5
```

Extensions can be added horizontally by introducing new transformation types, vertically by supporting additional API specifications, or through cross-cutting concerns like custom validation rules. Each extension point integrates into the existing pipeline structure.

## Quality Attributes

### Maintainability

The system maintains clarity through single-purpose transformations, declarative configuration, clear naming conventions, and comprehensive logging. Each component has a well-defined responsibility that's easy to understand and modify.

### Observability

The pipeline provides visibility through transformation counts, version information logging, contextual error messages, and console output showing progress. Users can see exactly what the tool is doing at each stage.

### Reliability

The architecture ensures correctness through fail-fast validation, GitHub API fallbacks, error handling at boundaries, and type safety via TypeScript. Invalid specs never reach the output stage.

### Extensibility

The design supports growth through a plugin-like transformation system, configuration-driven behavior, well-defined extension points, and minimal coupling between stages. New functionality can be added without modifying existing code.
