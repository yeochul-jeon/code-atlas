# CodeAtlas Design Spec

**Date**: 2026-04-13  
**Status**: Approved  
**Author**: Claude (brainstorming session)

---

## Context

When using Claude Code with Serena MCP on Java/Kotlin projects, every new conversation requires re-analyzing the same codebase from scratch — wasting time and tokens. CodeAtlas solves this by maintaining a persistent, queryable index of code structure and AI-generated summaries across multiple projects, exposed to Claude via an MCP server.

The goal is to give Claude IDE-level code navigation without repeated re-analysis: "what exists where" (cached by CodeAtlas) vs. "edit this symbol" (live via Serena).

---

## Problem Statement

- **Repeated re-analysis**: Each new Claude Code conversation re-parses the same Java/Kotlin source from scratch
- **No cross-project navigation**: No way to search symbols across multiple projects in one query
- **No persistent architectural context**: Class summaries, dependency maps, and dead code insights must be rediscovered each session
- **Dead code accumulation**: No tooling to identify unreferenced symbols across the codebase

---

## Architecture

### System Overview

```
Target Projects (Java/Kotlin)
         ↓
  CLI: codeatlas index
         ↓
  Indexer Pipeline
  ├── tree-sitter WASM parser (structural extraction)
  └── LSP enrichment (optional, type resolution)
         ↓
  Storage Layer (SQLite + FTS5)
  ├── symbols       (class/method/field hierarchy)
  ├── dependencies  (import/extends/implements)
  ├── references    (call/type-reference, dead code)
  └── summaries     (lazy AI-generated cache)
         ↓
  MCP Server (stdio / HTTP)
         ↓
  Claude Code
```

### Relationship with Serena

| Tool | Role |
|------|------|
| **CodeAtlas** | Cached index — "what exists where", dead code, bulk navigation |
| **Serena** | Live analysis — "edit this symbol", real-time type resolution |

They complement, not replace each other.

---

## Directory Structure

```
codeatlas/
├── src/
│   ├── cli/              # CLI entrypoint (commander.js)
│   ├── indexer/
│   │   ├── tree-sitter/  # tree-sitter WASM parsing (Java, Kotlin)
│   │   └── lsp/          # optional LSP enrichment (jdtls, kotlin-lsp)
│   ├── storage/          # SQLite + FTS5 store/query
│   ├── summarizer/       # lazy AI summary generation (Anthropic SDK)
│   └── mcp/              # MCP server tool definitions
├── .codeatlas/           # index DB storage (gitignored)
│   └── index.db          # SQLite database
├── docs/
│   └── superpowers/specs/
└── package.json
```

---

## Data Model (SQLite)

```sql
-- Project registry
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  last_indexed_at TEXT
);

-- File tracking (incremental indexing)
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  relative_path TEXT NOT NULL,
  content_hash TEXT,          -- SHA-256 for change detection
  last_indexed_at TEXT,
  UNIQUE(project_id, relative_path)
);

-- Symbol tree (class/method/field hierarchy)
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,         -- class | method | field | interface | enum | constructor
  signature TEXT,             -- method signature, field type
  parent_id INTEGER REFERENCES symbols(id),  -- hierarchy
  start_line INTEGER,
  end_line INTEGER,
  modifiers TEXT              -- JSON array: ["public", "static", "abstract"]
);

-- Dependency relationships (import/extends/implements)
CREATE TABLE dependencies (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER REFERENCES files(id),
  target_fqn TEXT NOT NULL,   -- fully qualified class name
  kind TEXT NOT NULL          -- import | extends | implements
);

-- Symbol references (for dead code detection)
CREATE TABLE references (
  id INTEGER PRIMARY KEY,
  source_symbol_id INTEGER REFERENCES symbols(id),  -- referencing symbol
  target_symbol_id INTEGER REFERENCES symbols(id),  -- referenced symbol
  kind TEXT NOT NULL          -- call | field_access | type_reference | annotation
);

-- AI-generated summaries (lazy cache)
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  symbol_id INTEGER REFERENCES symbols(id),  -- NULL = file-level summary
  content TEXT NOT NULL,
  generated_at TEXT,
  model_version TEXT
);

-- Full-text search
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, signature, content=symbols);
CREATE VIRTUAL TABLE summaries_fts USING fts5(content, content=summaries);
```

---

## MCP Tools (16 tools)

Tools are split into **read** (navigation) and **write** (editing) categories. CodeAtlas replaces Serena for both navigation and basic symbol editing across all indexed projects.

### Read Tools (10)

| Tool | Input | Output |
|------|-------|--------|
| `search_symbols` | `query`, `kind?`, `project?`, `limit?` | Matching symbols with file path, line, signature |
| `get_file_overview` | `file_path` | Class/method/field tree |
| `get_symbol_detail` | `file_path`, `symbol_name` | Signature, hierarchy, dependencies |
| `get_file_summary` | `file_path` | AI-generated natural language summary (lazy: generated on first call, then cached) |
| `get_dependencies` | `file_path` or `fqn` | import/extends/implements list |
| `find_implementors` | `interface_fqn` | List of implementing classes |
| `list_projects` | - | Project names, paths, last indexed timestamp |
| `get_package_tree` | `project?`, `depth?` | Package hierarchy tree |
| `find_dead_code` | `project?`, `kind?`, `threshold?` | Unreferenced symbols (filtered by framework exclusion rules) |
| `get_symbol_references` | `symbol_name`, `project?` | All reference locations |

### Write Tools (6) — Serena Replacement

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `read_symbol_body` | `file_path`, `symbol_name` | Full source text of the symbol | Reads from file using DB-stored line range |
| `read_file_range` | `file_path`, `start_line`, `end_line` | Source lines in range | Context window for editing |
| `replace_symbol_body` | `file_path`, `symbol_name`, `new_content` | Success / error | Atomic write; re-indexes file after edit |
| `insert_after_symbol` | `file_path`, `symbol_name`, `content` | Success / error | Inserts after `end_line` of symbol |
| `insert_before_symbol` | `file_path`, `symbol_name`, `content` | Success / error | Inserts before `start_line` of symbol |
| `rename_symbol` | `file_path`, `symbol_name`, `new_name`, `project?` | Changed file list | Text-based rename across project; re-indexes affected files |

#### Write Tool Safety Protocol

1. **Pre-write verification**: Re-parse file with tree-sitter to confirm symbol location matches DB (guards against stale index)
2. **Atomic write**: Write to `.tmp` file, then `rename()` — no partial writes
3. **Post-write re-index**: Trigger incremental re-index on affected file(s) automatically
4. **Limitation**: `rename_symbol` is text-based (not type-aware) — may miss dynamic dispatch or reflection usage

### Dead Code Detection Logic

```
Indexing time:
1. Extract all symbols (class/method/field) → symbols table
2. Extract import/extends/implements → dependencies table
3. Extract method-body call relationships → references table

Query time (find_dead_code):
- Find symbols with zero entries in references table
- Apply exclusion filters (see below)
- Return with confidence level (HIGH: no references, MEDIUM: only test references)
```

### Dead Code Exclusion Rules (Java/Kotlin Spring)

- `@RestController`, `@Service`, `@Component`, `@Repository` annotated classes
- `@Bean`, `@Configuration` methods
- `main()` entry points
- `@Override` methods
- `public static final` constants (reported separately)
- Custom exclude patterns via `.codeatlas.yaml`

---

## Indexing Pipeline

### Two-Phase Parsing

**Phase 1 — tree-sitter (always runs)**
- Fast structural extraction: classes, methods, fields, signatures
- Extracts modifiers, annotations, parent relationships
- Extracts method-body symbol references for dead code detection
- Performance: handles 36K+ files (bts project) in minutes

**Phase 2 — LSP enrichment (optional, `--with-lsp` flag)**
- Uses existing jdtls/kotlin-lsp installations
- Adds resolved generic types, full inheritance chains
- Targeted: only runs on files explicitly requested, not bulk

### Incremental Indexing

```
codeatlas index <path> --incremental:
1. For each file: compute SHA-256
2. Compare with stored content_hash
3. If unchanged: skip
4. If changed:
   a. Delete existing symbols, dependencies, references for this file
   b. Re-parse with tree-sitter
   c. Invalidate related summaries
   d. Update content_hash
```

### AI Summary Generation (Lazy)

- Summaries are **not** generated during indexing (avoids upfront API cost)
- Generated on first `get_file_summary` MCP call
- Cached in `summaries` table with `model_version` for cache invalidation
- File-level summaries include: purpose, key classes, public API surface

---

## CLI Interface

```bash
# Indexing
codeatlas index <project-path>                # full index
codeatlas index <project-path> --incremental  # changed files only
codeatlas index <project-path> --with-lsp     # with LSP type enrichment

# MCP server
codeatlas serve                               # stdio mode (Claude Code)
codeatlas serve --port 9200                   # HTTP mode

# Query (debug / standalone use)
codeatlas search <query>                      # symbol search
codeatlas dead-code <project-path>            # dead code report
codeatlas stats                               # index statistics

# Project management
codeatlas list                                # registered projects
codeatlas remove <project-id>                 # remove project index
```

---

## Technology Stack

| Area | Technology |
|------|-----------|
| Language | TypeScript (Node.js) |
| Parsing | tree-sitter WASM (java, kotlin grammars) |
| Optional enrichment | jdtls, kotlin-lsp (already installed) |
| Storage | SQLite + better-sqlite3 + FTS5 |
| MCP | @modelcontextprotocol/sdk |
| AI summaries | @anthropic-ai/sdk (claude-sonnet-4-6) |
| CLI | commander.js |
| Future: vector search | LanceDB (Phase 2) |

---

## Configuration (`.codeatlas.yaml`)

```yaml
projects:
  - name: cjos-hexa-arch-sample
    path: ../cjos-hexa-arch-sample
  - name: cjos-commons
    path: ../cjos-commons

dead_code:
  exclude_annotations:
    - "@RestController"
    - "@Service"
    - "@Component"
    - "@Repository"
    - "@Bean"
  exclude_patterns:
    - "**/*Test.java"
    - "**/*Test.kt"

summaries:
  model: claude-sonnet-4-6
  max_file_size_kb: 100  # skip very large files
```

---

## Phased Rollout

| Phase | Scope | Key Deliverable | Storage Added |
|-------|-------|-----------------|---------------|
| **Phase 1** | tree-sitter indexer + SQLite + MCP server (10 read tools) | `search_symbols`, `get_file_overview` working with Claude Code | SQLite |
| **Phase 2** | Write tools — Serena replacement (6 tools) | `replace_symbol_body`, `rename_symbol` — Serena no longer needed | — |
| **Phase 3** | References table + dead code detection | `find_dead_code`, `get_symbol_references` tools | — |
| **Phase 4** | Lazy AI summaries | `get_file_summary` with caching | — |
| **Phase 5** | Vector search (LanceDB — embedded, no server) | `semantic_search` — natural language code search | LanceDB |
| **Phase 6** | Graph DB (Kuzu — embedded, no server) | `get_impact_analysis`, `find_circular_deps` — multi-hop traversal | Kuzu |

### Storage Stack Decision

- **Vector DB: LanceDB** — embedded, TypeScript-native, file-based (`.codeatlas/vectors/`), no server required
- **Graph DB: Kuzu** — embedded, Node.js bindings, Cypher query language (same as Neo4j), file-based (`.codeatlas/graph/`)
- Both are additive: SQLite remains the primary store; vector and graph layers are optional extensions

---

## Verification

End-to-end test plan:

1. `codeatlas index ../cjos-hexa-arch-sample` — verify symbol count, no errors
2. `codeatlas search "UserService"` — verify results with file path + line number
3. `codeatlas serve` → ask Claude Code: "List all classes in cjos-hexa-arch-sample" — verify MCP tools are called
4. `codeatlas dead-code ../cjos-hexa-arch-sample` — verify output excludes Spring annotations
5. `codeatlas index ../cjos-hexa-arch-sample --incremental` (after touching one file) — verify only that file is re-indexed
6. MCP `get_file_summary` — verify summary is generated and cached on second call (no API call on second call)
