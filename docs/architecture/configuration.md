# 설정 파일 (.codeatlas.yaml)

CodeAtlas는 프로젝트 루트에 `.codeatlas.yaml` 파일을 배치하여  
인덱서, 데드 코드 검출, AI 요약 동작을 프로젝트별로 커스터마이징할 수 있습니다.

**관련 파일**: `src/config/loader.ts`

---

## 파일 위치

```
your-project/
  .codeatlas.yaml    ← 여기에 배치
  src/
  pom.xml
  build.gradle
```

`codeatlas index <path>` 또는 `codeatlas dead-code` 실행 시 프로젝트 루트에서 자동으로 로드됩니다.  
파일이 없으면 모든 기본값을 사용합니다.

---

## 전체 스키마

```yaml
# .codeatlas.yaml

# ─── 인덱서 설정 ────────────────────────────────────────────────
indexer:
  # 인덱싱할 파일 확장자 (지정 시 기본값 교체)
  # 기본값: [".java"]
  extensions:
    - ".java"
    - ".js"
    - ".ts"
    - ".jsx"
    - ".tsx"
    - ".vue"
    - ".xml"

  # 제외할 디렉토리 (지정 시 기본값 교체)
  # 기본값: ["node_modules", "build", "target", ".gradle"]
  skip_dirs:
    - "node_modules"
    - "build"
    - "target"
    - ".gradle"
    - "vendor"
    - "dist"

# ─── 데드 코드 검출 설정 ────────────────────────────────────────
dead_code:
  # 제외할 어노테이션 (replace_annotations: false 시 기본값에 append)
  # 기본값: Spring/아키텍처 어노테이션 12개
  exclude_annotations:
    - "@CustomEntry"
    - "@EventHandler"

  # true: exclude_annotations로 기본값 완전 교체
  # false (기본): 기본값에 위 목록을 추가
  replace_annotations: false

  # 특정 파일 경로 패턴의 심볼을 데드 코드 검출에서 제외 (picomatch glob)
  exclude_patterns:
    - "**/*Test.java"
    - "**/*Config.java"
    - "**/generated/**"

# ─── AI 요약 설정 ───────────────────────────────────────────────
summaries:
  # AI 요약 생성에 사용할 Anthropic 모델
  # 기본값: "claude-sonnet-4-6"
  model: "claude-sonnet-4-6"
```

---

## 섹션별 설명

### `indexer`

#### `extensions`

인덱싱할 파일 확장자 목록입니다. **기본값을 교체**합니다.

| 기본값 | 이유 |
|--------|------|
| `".java"` | Java 파서만 완전 지원 |

확장자를 추가하면 해당 파일이 수집되어 파일 레코드가 생성됩니다.  
단, 파서가 연결된 언어만 심볼 추출이 됩니다:

| 확장자 | 파일 수집 | 심볼 추출 |
|--------|:--------:|:--------:|
| `.java` | ✓ | ✓ |
| `.kt` | ✓ | - (계획 중) |
| `.js`, `.ts`, `.vue` | ✓ | - (계획 중) |
| `.xml` | ✓ | - (파서 없음) |

```yaml
# Java + 프론트엔드 파일 수집 (심볼 추출은 Java만)
indexer:
  extensions: [".java", ".ts", ".vue", ".xml"]
```

#### `skip_dirs`

제외할 디렉토리 이름 목록입니다. **기본값을 교체**합니다.

기본값: `node_modules`, `build`, `target`, `.gradle`

```yaml
# 벤더 디렉토리와 dist도 제외
indexer:
  skip_dirs: ["node_modules", "build", "target", ".gradle", "vendor", "dist"]
```

> **주의**: 기본값을 완전히 교체하므로 기본 항목도 명시적으로 포함해야 합니다.

---

### `dead_code`

#### `exclude_annotations`

이 어노테이션이 달린 심볼은 참조가 없어도 데드 코드로 분류하지 않습니다.

**기본 제외 어노테이션 (12개)**:
- `@RestController`, `@Controller`
- `@Service`, `@Component`, `@Repository`
- `@Bean`, `@Configuration`
- `@Override`
- `@WebAdapter`, `@UseCase`
- `@PersistenceAdapter`, `@ApiAdapter`

```yaml
# 커스텀 아키텍처 어노테이션 추가 (기본 12개 + CustomEntry)
dead_code:
  exclude_annotations:
    - "@CustomEntry"
```

#### `replace_annotations`

| 값 | 동작 |
|----|------|
| `false` (기본) | `exclude_annotations` 목록을 기본 12개에 추가 |
| `true` | `exclude_annotations` 목록으로 기본값 완전 교체 |

```yaml
# 기본 어노테이션 무시하고 완전히 새 목록 사용
dead_code:
  replace_annotations: true
  exclude_annotations:
    - "@Entry"
    - "@EventHandler"
```

#### `exclude_patterns`

지정된 glob 패턴에 매칭되는 파일 경로의 심볼은 데드 코드 검출에서 제외합니다.  
[picomatch](https://github.com/micromatch/picomatch) 문법을 사용합니다.

```yaml
dead_code:
  exclude_patterns:
    - "**/*Test.java"          # 테스트 파일 전체
    - "**/*Config.java"        # 설정 파일
    - "**/generated/**"        # 코드 생성 디렉토리
    - "src/main/java/com/example/legacy/**"  # 특정 패키지
```

**경로 기준**: 프로젝트 루트 기준 상대 경로 (`relative_path`)와 매칭합니다.

---

### `summaries`

#### `model`

AI 파일 요약 생성에 사용할 Anthropic 모델 ID입니다.

| 모델 | 특징 |
|------|------|
| `claude-sonnet-4-6` (기본) | 고품질 요약 |
| `claude-haiku-4-5-20251001` | 빠르고 저렴 |
| `claude-opus-4-6` | 최고 품질 |

```yaml
# 비용 절감을 위해 Haiku 사용
summaries:
  model: "claude-haiku-4-5-20251001"
```

> 모델을 변경하면 기존 캐시된 요약은 무효화되어 다음 호출 시 재생성됩니다.

---

## 기본값 동작

`.codeatlas.yaml` 파일이 없거나 특정 필드가 누락된 경우:

```typescript
// src/config/loader.ts의 기본값 상수

DEFAULT_EXTENSIONS  = ['.java']
DEFAULT_SKIP_DIRS   = ['node_modules', 'build', 'target', '.gradle']
DEFAULT_MODEL       = 'claude-sonnet-4-6'
DEFAULT_EXCLUDED_ANNOTATIONS = new Set([
  '@RestController', '@Controller',
  '@Service', '@Component', '@Repository',
  '@Bean', '@Configuration', '@Override',
  '@WebAdapter', '@UseCase',
  '@PersistenceAdapter', '@ApiAdapter',
])
```

각 섹션은 독립적으로 기본값이 채워집니다:

```yaml
# indexer만 지정해도 dead_code, summaries는 기본값 사용
indexer:
  extensions: [".java", ".ts"]
```

---

## 오류 처리

| 상황 | 동작 |
|------|------|
| 파일 없음 | 모든 기본값 사용 (경고 없음) |
| 잘못된 YAML 문법 | 모든 기본값 사용 + stderr에 경고 출력 |
| 필드 값이 잘못된 타입 | 해당 필드만 기본값 사용 |

---

## 사용 예시

### Java 모노레포

```yaml
indexer:
  extensions: [".java"]
  skip_dirs: ["node_modules", "build", "target", ".gradle", "docs"]

dead_code:
  exclude_annotations:
    - "@Entry"
    - "@Scheduled"
    - "@KafkaListener"
  exclude_patterns:
    - "**/*Test.java"
    - "**/*IT.java"
    - "**/test/**"
```

### Spring Boot + Vue.js 멀티모듈

```yaml
indexer:
  extensions: [".java", ".ts", ".vue"]
  skip_dirs: ["node_modules", "build", "target", ".gradle", "dist", ".nuxt"]

dead_code:
  exclude_annotations:
    - "@RestController"
    - "@Service"
    - "@Repository"
    - "@Component"
    - "@Bean"
    - "@Configuration"
    - "@Override"
    - "@EventListener"
  replace_annotations: true  # Spring 기본값 유지하면서 추가 불필요, 직접 관리

summaries:
  model: "claude-haiku-4-5-20251001"
```

### 레거시 코드베이스 (테스트 · 생성 코드 대거 제외)

```yaml
dead_code:
  exclude_patterns:
    - "**/*Test.java"
    - "**/*Tests.java"
    - "**/generated/**"
    - "**/legacy/**"
    - "src/main/java/com/example/old/**"
```
