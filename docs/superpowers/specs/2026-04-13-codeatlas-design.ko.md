# CodeAtlas 설계 스펙

**작성일**: 2026-04-13  
**상태**: 승인  
**작성자**: Claude (브레인스토밍 세션)

---

## 배경

Java/Kotlin 프로젝트에서 Claude Code와 Serena MCP를 사용할 때, 새 대화를 시작할 때마다 동일한 코드베이스를 처음부터 재분석해야 합니다 — 시간과 토큰 낭비가 발생합니다. CodeAtlas는 여러 프로젝트에 걸쳐 코드 구조와 AI 생성 요약을 영속적으로 저장하고 MCP 서버를 통해 Claude에 제공함으로써 이 문제를 해결합니다.

목표: 반복 재분석 없이 Claude에게 IDE 수준의 코드 탐색 능력을 부여하는 것.  
역할 분담: "무엇이 어디에 있나" → CodeAtlas (캐시) / "이 심볼을 편집" → Serena (라이브).

---

## 문제 정의

- **반복적 재분석**: 새 Claude Code 대화마다 동일한 Java/Kotlin 소스를 처음부터 파싱
- **프로젝트 간 탐색 불가**: 여러 프로젝트에 걸쳐 심볼을 한 번에 검색하는 방법 없음
- **아키텍처 컨텍스트 미보존**: 클래스 요약, 의존성 지도, 데드 코드 정보를 매 세션마다 다시 파악해야 함
- **데드 코드 누적**: 코드베이스 전체에서 미참조 심볼을 식별하는 도구 없음

---

## 아키텍처

### 시스템 개요

```
대상 프로젝트 (Java/Kotlin)
         ↓
  CLI: codeatlas index
         ↓
  인덱서 파이프라인
  ├── tree-sitter WASM 파서 (구조적 추출)
  └── LSP 보강 (선택적, 타입 해석)
         ↓
  저장 레이어 (SQLite + FTS5)
  ├── symbols      (클래스/메서드/필드 계층)
  ├── dependencies (import/extends/implements)
  ├── references   (호출/타입 참조, 데드 코드용)
  └── summaries    (lazy AI 생성 캐시)
         ↓
  MCP 서버 (stdio / HTTP)
         ↓
  Claude Code
```

### Serena와의 관계

| 도구 | 역할 |
|------|------|
| **CodeAtlas** | 캐시된 인덱스 — "무엇이 어디에 있나", 데드 코드, 대규모 탐색 |
| **Serena** | 라이브 분석 — "이 심볼을 편집", 실시간 타입 해석 |

두 도구는 대체가 아닌 상호 보완 관계입니다.

---

## 디렉토리 구조

```
codeatlas/
├── src/
│   ├── cli/              # CLI 진입점 (commander.js)
│   ├── indexer/
│   │   ├── tree-sitter/  # tree-sitter WASM 파싱 (Java, Kotlin)
│   │   └── lsp/          # 선택적 LSP 보강 (jdtls, kotlin-lsp)
│   ├── storage/          # SQLite + FTS5 저장/조회
│   ├── summarizer/       # lazy AI 요약 생성 (Anthropic SDK)
│   └── mcp/              # MCP 서버 도구 정의
├── .codeatlas/           # 인덱스 DB 저장 위치 (gitignore)
│   └── index.db          # SQLite 데이터베이스
├── docs/
│   └── superpowers/specs/
└── package.json
```

---

## 데이터 모델 (SQLite)

```sql
-- 프로젝트 등록
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  last_indexed_at TEXT
);

-- 파일 추적 (증분 인덱싱용)
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  relative_path TEXT NOT NULL,
  content_hash TEXT,          -- 변경 감지용 SHA-256
  last_indexed_at TEXT,
  UNIQUE(project_id, relative_path)
);

-- 심볼 트리 (클래스/메서드/필드 계층)
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,         -- class | method | field | interface | enum | constructor
  signature TEXT,             -- 메서드 시그니처, 필드 타입
  parent_id INTEGER REFERENCES symbols(id),  -- 계층 구조
  start_line INTEGER,
  end_line INTEGER,
  modifiers TEXT              -- JSON 배열: ["public", "static", "abstract"]
);

-- 의존 관계 (import/extends/implements)
CREATE TABLE dependencies (
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER REFERENCES files(id),
  target_fqn TEXT NOT NULL,   -- 완전 정규화된 클래스명
  kind TEXT NOT NULL          -- import | extends | implements
);

-- 심볼 참조 관계 (데드 코드 검출용)
CREATE TABLE references (
  id INTEGER PRIMARY KEY,
  source_symbol_id INTEGER REFERENCES symbols(id),  -- 참조하는 심볼
  target_symbol_id INTEGER REFERENCES symbols(id),  -- 참조되는 심볼
  kind TEXT NOT NULL          -- call | field_access | type_reference | annotation
);

-- AI 생성 요약 (lazy 캐시)
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  symbol_id INTEGER REFERENCES symbols(id),  -- NULL이면 파일 수준 요약
  content TEXT NOT NULL,
  generated_at TEXT,
  model_version TEXT
);

-- 전문 검색 (Full-text search)
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, signature, content=symbols);
CREATE VIRTUAL TABLE summaries_fts USING fts5(content, content=summaries);
```

---

## MCP 도구 (16개)

도구는 **읽기** (탐색)와 **쓰기** (편집) 두 범주로 구분됩니다. CodeAtlas는 탐색과 기본 심볼 편집 모두에서 Serena를 대체합니다.

### 읽기 도구 (10개)

| 도구 | 입력 | 출력 |
|------|------|------|
| `search_symbols` | `query`, `kind?`, `project?`, `limit?` | 파일 경로·라인·시그니처 포함 매칭 심볼 목록 |
| `get_file_overview` | `file_path` | 클래스/메서드/필드 트리 |
| `get_symbol_detail` | `file_path`, `symbol_name` | 시그니처, 계층, 의존관계 |
| `get_file_summary` | `file_path` | AI 생성 자연어 요약 (lazy: 첫 호출 시 생성, 이후 캐시 반환) |
| `get_dependencies` | `file_path` 또는 `fqn` | import/extends/implements 목록 |
| `find_implementors` | `interface_fqn` | 구현 클래스 목록 |
| `list_projects` | - | 프로젝트명, 경로, 마지막 인덱싱 시각 |
| `get_package_tree` | `project?`, `depth?` | 패키지 계층 트리 |
| `find_dead_code` | `project?`, `kind?`, `threshold?` | 미참조 심볼 목록 (프레임워크 제외 규칙 적용) |
| `get_symbol_references` | `symbol_name`, `project?` | 모든 참조 위치 |

### 쓰기 도구 (6개) — Serena 대체

| 도구 | 입력 | 출력 | 비고 |
|------|------|------|------|
| `read_symbol_body` | `file_path`, `symbol_name` | 심볼 전체 소스 텍스트 | DB 저장 라인 범위로 파일 직접 읽기 |
| `read_file_range` | `file_path`, `start_line`, `end_line` | 해당 라인 범위 소스 | 편집용 컨텍스트 창 |
| `replace_symbol_body` | `file_path`, `symbol_name`, `new_content` | 성공 / 오류 | 원자적 쓰기; 편집 후 자동 재인덱싱 |
| `insert_after_symbol` | `file_path`, `symbol_name`, `content` | 성공 / 오류 | 심볼 `end_line` 이후에 삽입 |
| `insert_before_symbol` | `file_path`, `symbol_name`, `content` | 성공 / 오류 | 심볼 `start_line` 이전에 삽입 |
| `rename_symbol` | `file_path`, `symbol_name`, `new_name`, `project?` | 변경된 파일 목록 | 프로젝트 전체 텍스트 기반 rename; 영향 파일 자동 재인덱싱 |

#### 쓰기 도구 안전 프로토콜

1. **사전 검증**: 쓰기 전 tree-sitter로 파일 재파싱하여 DB의 심볼 위치 일치 확인 (stale 인덱스 방지)
2. **원자적 쓰기**: `.tmp` 파일에 먼저 쓴 후 `rename()` — 부분 쓰기 없음
3. **사후 재인덱싱**: 편집된 파일에 대해 증분 재인덱싱 자동 실행
4. **제한사항**: `rename_symbol`은 텍스트 기반으로 동적 디스패치·리플렉션 사용처는 탐지 불가

### 데드 코드 검출 로직

```
인덱싱 시:
1. 모든 심볼 추출 (클래스/메서드/필드) → symbols 테이블
2. import/extends/implements 관계 추출 → dependencies 테이블
3. 메서드 본문 내 호출 관계 추출 → references 테이블

조회 시 (find_dead_code):
- references 테이블에 단 한 번도 참조되지 않은 심볼 검색
- 제외 필터 적용 (아래 참조)
- 신뢰도 등급 포함 반환 (HIGH: 참조 없음, MEDIUM: 테스트에서만 참조)
```

### 데드 코드 제외 규칙 (Java/Kotlin Spring)

- `@RestController`, `@Service`, `@Component`, `@Repository` 어노테이션이 붙은 클래스
- `@Bean`, `@Configuration` 메서드
- `main()` 진입점
- `@Override` 메서드
- `public static final` 상수 (별도 카테고리로 분류)
- `.codeatlas.yaml`을 통한 커스텀 제외 패턴

---

## 인덱싱 파이프라인

### 2단계 파싱

**1단계 — tree-sitter (항상 실행)**
- 빠른 구조적 추출: 클래스, 메서드, 필드, 시그니처
- 수정자, 어노테이션, 부모 관계 추출
- 데드 코드 검출을 위한 메서드 본문 내 심볼 참조 추출
- 성능: 36K+ 파일 (`bts` 프로젝트) 수 분 내 처리

**2단계 — LSP 보강 (선택적, `--with-lsp` 플래그)**
- 기존 jdtls/kotlin-lsp 설치를 활용
- 해석된 제네릭 타입, 완전한 상속 체인 추가
- 선택적 실행: 대량 처리가 아닌 명시적으로 요청된 파일에만 적용

### 증분 인덱싱

```
codeatlas index <path> --incremental:
1. 각 파일의 SHA-256 계산
2. 저장된 content_hash와 비교
3. 동일하면: 건너뜀
4. 다르면:
   a. 해당 파일의 기존 symbols, dependencies, references 삭제
   b. tree-sitter로 재파싱
   c. 관련 summaries 무효화
   d. content_hash 업데이트
```

### AI 요약 생성 (Lazy)

- 인덱싱 시 요약을 생성하지 않음 (초기 API 비용 방지)
- `get_file_summary` MCP 호출 시 최초 1회 생성
- `model_version` 포함하여 `summaries` 테이블에 캐시 (캐시 무효화 지원)
- 파일 수준 요약 내용: 목적, 핵심 클래스, public API 표면

---

## CLI 인터페이스

```bash
# 인덱싱
codeatlas index <project-path>                # 전체 인덱싱
codeatlas index <project-path> --incremental  # 변경 파일만
codeatlas index <project-path> --with-lsp     # LSP 타입 보강 포함

# MCP 서버
codeatlas serve                               # stdio 모드 (Claude Code 연동)
codeatlas serve --port 9200                   # HTTP 모드

# 조회 (디버깅/단독 사용)
codeatlas search <query>                      # 심볼 검색
codeatlas dead-code <project-path>            # 데드 코드 리포트
codeatlas stats                               # 인덱스 통계

# 프로젝트 관리
codeatlas list                                # 등록된 프로젝트 목록
codeatlas remove <project-id>                 # 프로젝트 인덱스 삭제
```

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 구현 언어 | TypeScript (Node.js) |
| 파싱 | tree-sitter WASM (java, kotlin grammars) |
| 선택적 보강 | jdtls, kotlin-lsp (기설치) |
| 저장소 | SQLite + better-sqlite3 + FTS5 |
| MCP | @modelcontextprotocol/sdk |
| AI 요약 | @anthropic-ai/sdk (claude-sonnet-4-6) |
| CLI | commander.js |
| 향후 벡터 검색 | LanceDB (Phase 2) |

---

## 설정 파일 (`.codeatlas.yaml`)

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
  max_file_size_kb: 100  # 대용량 파일 건너뜀
```

---

## 단계별 출시 계획

| 단계 | 범위 | 핵심 산출물 |
|------|------|------------|
| **Phase 1** | tree-sitter 인덱서 + SQLite + MCP 서버 (읽기 10개 도구) | Claude Code에서 `search_symbols`, `get_file_overview` 동작 | SQLite |
| **Phase 2** | 쓰기 도구 — Serena 대체 (6개 도구) | `replace_symbol_body`, `rename_symbol` — Serena 불필요 | — |
| **Phase 3** | references 테이블 + 데드 코드 검출 | `find_dead_code`, `get_symbol_references` 도구 | — |
| **Phase 4** | Lazy AI 요약 | `get_file_summary` 캐싱 포함 동작 | — |
| **Phase 5** | 벡터 검색 (LanceDB — 임베디드, 서버 불필요) | `semantic_search` — 자연어 코드 검색 | LanceDB |
| **Phase 6** | 그래프 DB (Kuzu — 임베디드, 서버 불필요) | `get_impact_analysis`, `find_circular_deps` — 다단계 순회 | Kuzu |

### 저장소 스택 결정

- **벡터 DB: LanceDB** — 임베디드, TypeScript 네이티브, 파일 기반 (`.codeatlas/vectors/`), 서버 불필요
- **그래프 DB: Kuzu** — 임베디드, Node.js 바인딩, Cypher 쿼리 언어 (Neo4j와 동일), 파일 기반 (`.codeatlas/graph/`)
- 두 저장소 모두 추가(additive) 방식: SQLite가 핵심 저장소로 유지되며 벡터·그래프 레이어는 선택적 확장

---

## 검증 계획

엔드투엔드 테스트:

1. `codeatlas index ../cjos-hexa-arch-sample` — 심볼 수 확인, 오류 없음 확인
2. `codeatlas search "UserService"` — 파일 경로 + 라인 번호 포함 결과 확인
3. `codeatlas serve` 후 Claude Code에서 "cjos-hexa-arch-sample의 모든 클래스 나열" — MCP 도구 호출 확인
4. `codeatlas dead-code ../cjos-hexa-arch-sample` — Spring 어노테이션이 붙은 클래스 제외 확인
5. `codeatlas index ../cjos-hexa-arch-sample --incremental` (파일 수정 후) — 해당 파일만 재인덱싱 확인
6. MCP `get_file_summary` 두 번 호출 — 두 번째 호출 시 API 요청 없이 캐시 반환 확인
