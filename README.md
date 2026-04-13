# CodeAtlas

Java/Kotlin 프로젝트를 영속적 코드 인덱스로 변환하고, MCP 서버로 노출하여  
Claude 같은 AI 에이전트에게 IDE 수준의 코드 탐색 능력을 제공합니다.

---

## 문서

| 문서 | 설명 |
|------|------|
| [퀵스타트](./docs/quickstart.md) | 5분 안에 시작하기 |
| [단계별 가이드](./docs/guide.md) | 모든 기능 상세 사용법 |
| [아키텍처 개요](./docs/architecture/overview.md) | 전체 설계 및 데이터 흐름 |
| [저장소 계층](./docs/architecture/storage.md) | SQLite 스키마 + LanceDB |
| [인덱싱 엔진](./docs/architecture/indexer.md) | tree-sitter 파싱 파이프라인 |
| [MCP 서버 & 도구](./docs/architecture/mcp-server.md) | 17개 도구 레퍼런스 |
| [설정 파일](./docs/architecture/configuration.md) | .codeatlas.yaml 스키마 |

---

## 빠른 시작

```bash
npm install && npm run build

# 프로젝트 인덱싱
codeatlas index /path/to/your-project

# MCP 서버 시작 (Claude Code와 연동)
codeatlas serve
```

자세한 내용은 [퀵스타트](./docs/quickstart.md)를 참고하세요.

---

## 주요 기능

- **코드 인덱싱**: tree-sitter로 Java 소스 파싱 → SQLite 영속 저장
- **키워드 검색**: FTS5 전문 검색으로 심볼 이름 밀리초 탐색
- **시맨틱 검색**: 로컬 임베딩 모델(all-MiniLM-L6-v2) + LanceDB
- **데드 코드 검출**: Spring 어노테이션 기반 제외 규칙 + glob 패턴
- **AI 요약**: Anthropic API로 파일 요약 생성 + DB 캐시
- **코드 편집**: MCP 도구로 심볼 교체·삽입·이름 변경 (원자적 쓰기)
- **MCP 서버**: 17개 도구를 Claude Code에 제공
