# 저장소 계층

CodeAtlas는 두 가지 저장소를 사용합니다:
- **SQLite + FTS5**: 심볼, 의존성, 참조, 요약의 구조적 저장 및 키워드 검색
- **LanceDB**: 시맨틱 검색을 위한 벡터 임베딩 저장

---

## SQLite 스키마

**파일**: `src/storage/database.ts`  
**경로**: `~/.codeatlas/index.db`  
**스키마 버전**: 2 (자동 마이그레이션)  
**Pragma**: WAL 모드, 외래키 ON, synchronous NORMAL

### 테이블 구조

```
projects
  │
  └── files (project_id FK)
        │
        ├── symbols (file_id FK, parent_id self-ref FK)
        │     │
        │     └── refs (source_symbol_id FK, target_symbol_id FK)
        │
        ├── dependencies (source_file_id FK)
        │
        └── summaries (file_id FK, symbol_id FK)
```

---

### 테이블 상세

#### `projects`

```sql
CREATE TABLE projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL UNIQUE,
  last_indexed_at TEXT
)
```

| 컬럼 | 설명 |
|------|------|
| `name` | 프로젝트 이름 (사용자 지정 또는 디렉토리명) |
| `root_path` | 프로젝트 절대 경로 (UNIQUE 제약) |
| `last_indexed_at` | 마지막 인덱싱 시각 (ISO 8601) |

---

#### `files`

```sql
CREATE TABLE files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relative_path   TEXT NOT NULL,
  content_hash    TEXT,
  last_indexed_at TEXT,
  UNIQUE(project_id, relative_path)
)
```

| 컬럼 | 설명 |
|------|------|
| `relative_path` | 프로젝트 루트 기준 상대 경로 |
| `content_hash` | SHA-256 해시 (증분 인덱싱 변경 감지에 사용) |

---

#### `symbols`

```sql
CREATE TABLE symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  signature   TEXT,
  parent_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  modifiers   TEXT,   -- JSON 배열: ["public", "static", "final"]
  annotations TEXT    -- JSON 배열: ["@Service", "@Override"]
)
```

| 컬럼 | 설명 |
|------|------|
| `kind` | `class`, `interface`, `enum`, `method`, `constructor`, `field`, `record`, `annotation_type` |
| `signature` | 메서드 전체 시그니처: `public User findById(Long id)` |
| `parent_id` | 중첩 심볼의 부모 (예: 메서드 → 클래스) |
| `modifiers` | JSON 배열 (`["public", "static"]`) |
| `annotations` | JSON 배열 (`["@Service"]`) |

**자기 참조 구조** (parent_id):
```
UserService (class)
  └── findById (method) → parent_id = UserService.id
  └── save (method)     → parent_id = UserService.id
```

---

#### `dependencies`

```sql
CREATE TABLE dependencies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_fqn     TEXT NOT NULL,
  kind           TEXT NOT NULL   -- 'import' | 'extends' | 'implements'
)
```

Java 소스의 import, extends, implements 관계를 저장합니다.

---

#### `refs`

```sql
CREATE TABLE refs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL,   -- 'calls'
  callee_name      TEXT             -- 미해석 교차 파일 참조 (v2에서 추가)
)
```

| 컬럼 | 설명 |
|------|------|
| `target_symbol_id` | 동일 파일 내 참조는 즉시 해석하여 저장 |
| `callee_name` | 교차 파일 참조: 이름만 저장 → `resolveProjectRefs()`로 사후 해석 |

**마이그레이션 이력**:
- v1 → v2: `ALTER TABLE refs ADD COLUMN callee_name TEXT` 추가

---

#### `summaries`

```sql
CREATE TABLE summaries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER REFERENCES files(id) ON DELETE CASCADE,
  symbol_id    INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  content      TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model_version TEXT NOT NULL,
  UNIQUE(file_id, symbol_id)
)
```

| 컬럼 | 설명 |
|------|------|
| `content` | AI 생성 요약 텍스트 (2-4문장) |
| `model_version` | 생성에 사용된 모델 ID |
| `file_id` / `symbol_id` | 하나만 NOT NULL (파일 요약 or 심볼 요약) |

---

### FTS5 가상 테이블

키워드 검색을 위한 전문 검색 인덱스입니다.

```sql
-- 심볼 검색
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, signature, annotations,
  content='symbols', content_rowid='id'
)

-- 요약 검색
CREATE VIRTUAL TABLE summaries_fts USING fts5(
  content,
  content='summaries', content_rowid='id'
)
```

**FTS 동기화 트리거** (symbols → symbols_fts 자동 동기화):
- `symbols_ai`: INSERT 후 FTS 삽입
- `symbols_ad`: DELETE 후 FTS 삭제
- `symbols_au`: UPDATE 시 FTS 교체

---

### 인덱스

```sql
idx_files_project    ON files(project_id)
idx_symbols_file     ON symbols(file_id)
idx_symbols_name     ON symbols(name)
idx_symbols_kind     ON symbols(kind)
idx_symbols_parent   ON symbols(parent_id)
idx_deps_source      ON dependencies(source_file_id)
idx_refs_source      ON refs(source_symbol_id)
idx_refs_target      ON refs(target_symbol_id)
idx_summaries_file   ON summaries(file_id)
idx_summaries_symbol ON summaries(symbol_id)
```

---

### 검색 전략 (searchSymbolsFts)

`src/storage/queries.ts`의 `searchSymbolsFts()` 함수:

```
1. FTS5 prefix 매칭: "UserServ*" 형태로 빠른 전문 검색
   → 결과 있으면 반환
   
2. LIKE substring fallback: "%getUserById%" 형태로 camelCase 검색
   → FTS5 결과가 없을 때 사용
```

---

### 교차 파일 참조 해석 (resolveProjectRefs)

인덱싱 완료 후 실행되는 2단계 참조 해석:

```
Phase 1 (per-file): indexFile() 중
  동일 파일 내 메서드 호출 → callee_name을 당일 추출된 심볼명과 매칭
  target_symbol_id 즉시 설정

Phase 2 (project-wide): resolveProjectRefs()
  target_symbol_id가 NULL인 refs의 callee_name을
  프로젝트 전체 심볼명과 매칭 → target_symbol_id 업데이트
```

> 단순 이름 매칭 (FQN 미지원). 동명 심볼이 여러 개면 첫 번째 매칭 사용.

---

## LanceDB (벡터 저장소)

**파일**: `src/vectors/vector-store.ts`  
**경로**: `~/.codeatlas/vectors/`  
**용도**: `codeatlas embed` 후 시맨틱 검색에 사용

### VectorRecord 스키마

```typescript
interface VectorRecord {
  id: string;          // "file:42" 또는 "sym:17"
  vector: Float32Array; // 384차원 임베딩
  kind: string;         // "file" | "symbol"
  projectId: number;
  fileId?: number;
  symbolId?: number;
  text: string;         // 임베딩 생성에 사용된 원본 텍스트
}
```

### 주요 작업

| 메서드 | 설명 |
|--------|------|
| `VectorStore.open(path)` | DB 열기/생성 |
| `upsert(records)` | id 기준 upsert (merge-insert) |
| `search(vector, options)` | 벡터 유사도 검색 (optional: kind/projectId 필터) |
| `deleteByProject(projectId)` | 프로젝트 전체 벡터 삭제 |

---

## 데이터 위치 요약

| 데이터 | 경로 |
|--------|------|
| SQLite 인덱스 | `~/.codeatlas/index.db` |
| LanceDB 벡터 | `~/.codeatlas/vectors/` |
| 임베딩 모델 캐시 | `~/.cache/huggingface/` (Xenova 기본값) |
