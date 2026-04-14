# Gap-3 성능 검증 보고서

**작성일**: 2026-04-14  
**검증 대상**: `/Users/cjenm/cjenm/platform/bts`  
**검증 결과**: **전체 통과** (경고 1개)

---

## 1. 환경

| 항목 | 값 |
|------|---|
| OS | macOS 26.4.1 (Build 25E253) |
| CPU | Apple M1 Pro (8 cores) |
| RAM | 32 GB |
| Node.js | v24.7.0 |
| CodeAtlas | 0.1.0 |
| SQLite | 시스템 기본 |

---

## 2. 타깃 스펙

| 항목 | 값 |
|------|---|
| 경로 | `/Users/cjenm/cjenm/platform/bts` |
| `.java` 파일 | 36,516 |
| `.xml` 파일 | 11,118 |
| 총 파일 수 | 47,634 (수집 가능) |
| 총 용량 | 2.7 GB |
| git 저장소 | 아님 (Maven 멀티모듈) |
| `.codeatlas.yaml` | 신규 생성 (target/ 제외 설정) |

---

## 3. 측정 결과

### 3-1. 전체 인덱싱 (Cold Run)

**명령**: `/usr/bin/time -l node dist/cli/index.js index /bts`

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| Wall time (durationMs) | **133,426ms (2분 13초)** | ≤ 600,000ms (10분) | ✅ |
| real / user / sys | 150.5s / 109.5s / 22.0s | — | — |
| Peak RSS | **7,427,571,712 bytes (7.4 GB)** | — | ⚠️ |
| Peak memory footprint | 7,905,766,048 bytes (7.9 GB) | — | — |
| indexed | 46,545 파일 | — | — |
| skipped | 0 | — | — |
| errors | **430 (0.92%)** | < 5% | ✅ |

### 3-2. 심볼 통계 (post-hoc)

| 지표 | 값 |
|------|---|
| 총 프로젝트 수 | 2 (전체) |
| 총 파일 수 | 47,079 |
| 총 심볼 수 | **534,652** |
| 총 의존성 수 | 227,854 |
| DB 크기 | **144 MB** (`~/.codeatlas/index.db`) |

### 3-3. 증분 인덱싱 (Warm Run, 무변경)

**명령**: `/usr/bin/time -l node dist/cli/index.js index /bts --incremental`

| 지표 | 측정값 | 목표 | 판정 |
|------|--------|------|------|
| Wall time (durationMs) | **12,326ms (12.3초)** | ≤ 60,000ms (1분) | ✅ |
| real / user / sys | 12.5s / 2.8s / 4.7s | — | — |
| Peak RSS | **315,146,240 bytes (315 MB)** | — | ✅ |
| indexed | 0 | — | — |
| skipped | 46,975 (100%) | ~100% | ✅ |
| errors | 0 | — | ✅ |

> 증분 모드 메모리: Full run 대비 **96% 절감** (7.4GB → 315MB)

### 3-4. FTS5 쿼리 레이턴시

**도구**: `sqlite3 ~/.codeatlas/index.db` + `.timer on`

| 쿼리 패턴 | real | user | sys | 판정 |
|-----------|------|------|-----|------|
| `COUNT(*) FROM symbols` | 5ms | 1ms | 4ms | ✅ |
| `Controller*` MATCH | 1ms | 0.2ms | 0.3ms | ✅ |
| `Service*` MATCH | <1ms | 0.2ms | 0.1ms | ✅ |
| `save*` MATCH | 1ms | 0.7ms | 0.1ms | ✅ |
| `Repo*` MATCH | <1ms | 0.1ms | 0.0ms | ✅ |
| `find*` MATCH | <1ms | 0.1ms | 0.0ms | ✅ |

모든 FTS5 쿼리: **최대 5ms** (목표 50ms 이내) ✅

---

## 4. 판정 요약

| 검증 항목 | 목표 | 결과 | 판정 |
|-----------|------|------|------|
| 전체 인덱싱 시간 | ≤ 10분 | **2분 13초** | ✅ |
| 인덱싱 오류율 | < 5% | **0.92%** (430개) | ✅ |
| 증분 인덱싱 시간 | ≤ 1분 | **12.3초** | ✅ |
| FTS5 쿼리 레이턴시 | < 50ms | **최대 5ms** | ✅ |
| 전체 심볼 인덱싱 | 대규모 Java 지원 | **534,652개** | ✅ |
| DB 크기 | 합리적 | **144 MB** | ✅ |

**전체 통과** — bts 프로젝트 실전 사용 가능.

---

## 5. 발견된 이슈

### Issue-1: Full Index 피크 메모리 7.4 GB ⚠️

- **현상**: cold run 시 Node.js 힙이 최대 7.4GB RSS 사용
- **원인 추정**: 534K 심볼 + 228K 의존성 데이터를 SQLite INSERT 전에 메모리에 누적
- **현재 영향**: M1 Pro 32GB 환경에서 OOM 없음. 16GB 이하 환경에서 위험 가능성 있음.
- **후속 조치 권고**: Gap-3b — 배치 INSERT (청크 단위) + streaming SQL 트랜잭션 도입

### Issue-2: 오류 파일 430개 — "Invalid argument" (CRLF 관련 추정)

- **현상**: 430개 `.java` 파일이 `Invalid argument` 에러로 인덱싱 실패
- **파일 특징**: UTF-8 인코딩이나 **CRLF 줄바꿈** (`\r\n`) 사용 확인됨
  - 예: `bts-ch/ch-bcs-svc/src/main/java/cj/bts/ch/bcs/domains/bdtarget/service/PgmTeamTgtMngService.java`
- **원인 추정**: tree-sitter WASM 파서가 CRLF 입력을 처리할 때 발생하는 `EINVAL` 에러
- **오류율**: 0.92% — 목표 5% 이내 충족이나 완전 지원 권고
- **후속 조치 권고**: Gap-5 — 파일 읽기 시 `\r\n` → `\n` 정규화 (indexer.ts에서 Buffer 처리 전 replace)

---

## 6. 후속 조치 권고 (우선순위 순)

| 항목 | 내용 | 우선순위 |
|------|------|----------|
| Gap-3b | Full index 메모리 최적화 (배치 INSERT, streaming) | Medium |
| Gap-5 | CRLF Java 파일 파싱 수정 (0.92% 오류 해결) | Medium |
| Kotlin 파서 | tree-sitter-kotlin 연결 | Medium |
| JS/TS/Vue 심볼 추출 | 파일만 수집 중, 심볼 미추출 | Low |

---

## 7. 결론

CodeAtlas는 **36K+ Java 파일의 대규모 Maven 멀티모듈 프로젝트** (`bts`, 2.7GB)에서:

- 전체 인덱싱 **2분 13초** (목표의 22%)
- 증분 인덱싱 **12초** (목표의 20%)
- FTS5 쿼리 **1-5ms** (목표의 10% 이하)
- DB 크기 **144MB** — 실용적

모든 성능 목표를 충족. **Gap-3 완료 선언**.

주의 사항: Full index 시 피크 메모리 7.4GB (32GB 환경에서는 문제없으나 16GB 이하 주의).
