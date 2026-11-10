# WEEK 09 · 실습 2 — 검색·정렬·페이지네이션 게시판 개선

웹서비스설계 9주차 실습 2 저장소입니다.
첨부 예제(1,000건 인메모리 게시판)를 실행해 기능을 검증하고, 요구사항에 맞게 코드를 개선했습니다.

- 과제 안내: [WEEK 09 · 실습 2.md](./WEEK%2009%20·%20실습%202.md)
- 원본 코드 기준 커밋: 저장소의 첫 커밋 (`chore: 9주차 실습2 원본 예제 코드`)
- 수정 전/후 비교: 첫 커밋과 `main`을 GitHub Compare 화면에서 비교

---

## 실행 방법

요구 환경: Node.js 18 이상 (개발·검증 환경: Node.js v26.5.0, Express 5.3.0)

```bash
cd 실습코드
npm install      # package.json 기준으로 express 설치 (node_modules는 저장소에 없음)
npm start        # 또는 node server.js
npm run start:slow   # 느린 네트워크 실험용: API 응답을 1.5~3초 랜덤 지연 (요청 취소·응답 역전 확인)
```

브라우저에서 http://localhost:3000 에 접속합니다.

---

## 폴더 구조

```
.
├── README.md                # 이 문서
├── WEEK 09 · 실습 2.md      # 과제 안내문
└── 실습코드/
    ├── server.js            # Express API 서버 (오프셋 / 커서 페이지네이션)
    ├── index.html           # 게시판 SPA 클라이언트 + 요청 검사기
    ├── package.json
    └── README.md            # 예제 원본 설명
```

---

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/posts?page=&limit=&sort=&search=` | 오프셋 페이지네이션. `sort`는 `latest`(기본) · `oldest` · `views`. `limit` 최대 100 |
| GET | `/api/posts/cursor?cursor=&limit=&search=` | 커서 페이지네이션. `id DESC` 고정. `limit` 최대 50 |

파라미터 처리 규칙:
- `page`, `limit`, `cursor`: 숫자로만 된 양의 정수만 허용합니다. `0`, `-1`, `abc`, `2abc`는 기본값으로 처리합니다. 범위를 넘는 `page`는 마지막 페이지로 보정합니다.
- `sort`: 화이트리스트에 **자기 속성으로** 있는 키만 허용합니다(`Object.hasOwn`). 그 밖의 값은 모두 `latest`로 처리합니다.
- `search`: 문자열일 때만 사용하고, 앞뒤 공백을 제거한 뒤 소문자로 바꿔 최대 100자까지 씁니다. 같은 키가 반복돼 배열로 들어오면 무시합니다.

응답 `meta`:
- 오프셋: `page`, `limit`, `totalCount`, `totalPages`, `hasNext`, `hasPrev`, `sort`(실제 적용값), `search`, `executionTimeMs`
- 커서: `cursor`, `nextCursor`(다음이 없으면 `null`), `limit`, `fetchedCount`(limit + 1 조회 결과 수), `hasNext`, `search`, `order`, `executionTimeMs`

---

## 수정 내용 요약

원본과 비교하려면 첫 커밋(`chore: 9주차 실습2 원본 예제 코드`)과 `main`을 비교하면 됩니다.

### 검색·정렬 (`server.js`)
| 원본 | 수정 후 | 이유 |
|---|---|---|
| `SORT_WHITELIST[sortKey] \|\| latest` | `Object.hasOwn(SORT_WHITELIST, sortKey)`로 확인 | `sort=__proto__`, `hasOwnProperty`는 **500 에러**, `constructor`, `toString`은 우연히 정상처럼 보이는 숨은 결함 |
| `req.query.search.trim()` | `typeof === 'string'`을 확인한 뒤 사용 | `?search=a&search=b`처럼 배열이 들어오면 **500 에러** |
| 기본 HTML 에러 페이지 | JSON 404/500 에러 핸들러 | 500 응답에 스택 트레이스와 서버 절대 경로가 노출됨 |

### 페이지네이션 (`server.js`, `index.html`)
| 원본 | 수정 후 | 이유 |
|---|---|---|
| 커서 API에 검색 없음 | 검색 조건 + `id < cursor`를 적용하고 `limit + 1`개가 모이면 탐색 중단 | 요구사항 |
| `nextCursor`가 항상 마지막 id | `hasNext`일 때만 값을 주고, 아니면 `null` | 다음 페이지가 없는데 커서가 남지 않도록 |
| 커서 모드에서도 정렬 선택 가능 | 정렬 select 비활성화 + "id DESC 고정" 안내 | 정렬을 바꿔도 결과가 그대로라 혼란 |
| 응답이 도착했을 때 `!state.cursor`로 초기화 여부 판단 | 검색 변경·모드 전환 시점에 누적 목록·커서·hasNext를 즉시 초기화, 요청 시점의 커서 고정 | 누락·중복 방지 |
| `hasNext=false`이면 버튼 비활성화 | 버튼을 숨기고 "누적 N건 · 고유 id N건" 표시 | 마지막까지 누락·중복이 없음을 화면에서 확인 |

### 비동기 처리 (`index.html`, `server.js`)
| 원본 | 수정 후 | 이유 |
|---|---|---|
| AbortController만 사용 | abort + 요청 순번(`requestSeq`) 비교로 이중 방어 | 오래된 응답이 화면을 덮어쓰지 않도록 보장 |
| 오류 처리는 `console.error`만 | `res.ok` 확인, 화면에 오류 표시, AbortError는 로그만 남김 | 취소는 정상 흐름이고 실제 오류만 사용자에게 알림 |
| 검증 수단 없음 | 검사기에 전송·취소·무시 요청 수 표시, 콘솔 `[debounce]`·`[request #n]` 로그 | 디바운스 1회 요청과 취소를 눈으로 확인 |
| 응답 약 0.1ms | `npm run start:slow` (1.5~3초 랜덤 지연) | 느린 네트워크와 응답 순서 역전 재현 |
| — | 같은 검색어면 디바운스 요청 생략, Enter 즉시 검색(한글 조합 중 제외) | 불필요한 요청 제거 |

### URL 상태 복원 (`index.html`)
| 원본 | 수정 후 | 이유 |
|---|---|---|
| `parseInt(page) \|\| 1` | 양의 정수만 허용하는 `parsePage` | `page=-1`은 truthy라 그대로 상태에 남음 |
| URL의 `sort`를 검증하지 않음 | 화이트리스트로 확인하는 `parseSort` | 잘못된 값이면 select가 빈 값이 됨 |
| 초기 로드 시 URL 유지 | `replaceState`로 정규화, 서버가 보정한 `page`도 반영 | URL과 화면 불일치 방지 |
| 모든 변경을 `pushState` | 사용자 조작은 push, 정규화는 replace, 같은 URL이면 생략 | 중복 히스토리 방지 |
| `popstate` 시 모드 유지 | 오프셋 모드로 복귀하고 대기 중인 디바운스 취소 | URL은 오프셋 상태만 담음, 복원한 상태를 덮어쓰지 않도록 |

### 기타
- 정렬 라벨을 `created_at` 기준에서 `id` 기준으로 고쳤습니다. 더미 데이터의 `createdAt`은 id 순서와 맞지 않아서 서버가 실제로는 id로 정렬하기 때문입니다.
- SQL 미리보기에 사용자 입력을 직접 넣지 않고 `?` 바인딩 형태로 표시합니다. 테이블 출력에는 `escapeHtml`을 적용했습니다.

---

## 검증 결과 요약

서버 검증은 curl과 Node 스크립트로 수행했습니다. 화면 동작은 브라우저와 DevTools로 확인했고, 캡처는 실습 보고서에 첨부합니다.

| 항목 | 입력 | 결과 |
|---|---|---|
| 정렬 화이트리스트 | `sort=__proto__`, `constructor`, `toString`, `hasOwnProperty`, `views; DROP TABLE--` | 모두 200, `meta.sort = latest` |
| 페이지 파라미터 | `page=0`, `-1`, `abc` / `limit=1000` / `page=999` | page 1 / limit 100 / 마지막 페이지(100) |
| 조회수 동점 | `sort=views` 1,000건 전체 | 동점 90쌍 모두 id DESC |
| 커서 + 검색 | `B-Tree`로 끝까지 순회 | 누적 84건 = 오프셋 `totalCount` 84, 중복 0 |
| limit + 1 | `cursor?limit=10&search=B-Tree` | `fetchedCount: 11`, `hasNext: true` / 마지막 `fetchedCount: 4`, `hasNext: false` |

---

## 개념 정리

### ① 오프셋과 커서에 적합한 화면

- **오프셋 (`LIMIT / OFFSET`)**: 전체 개수와 페이지 번호가 필요하고, 특정 페이지로 바로 이동해야 하는 화면에 적합합니다. 예: 게시판 목록, 관리자 테이블, 검색 결과 페이지
- **커서 (`WHERE id < ?`)**: 끊김 없이 이어서 불러오는 화면이나, 데이터가 계속 추가되는 화면에 적합합니다. 예: SNS 피드, 채팅, 알림, 무한 스크롤
- 오프셋은 앞쪽 데이터가 추가·삭제되면 다음 페이지에서 중복이나 누락이 생길 수 있고, OFFSET이 클수록 앞의 행을 읽고 버리는 비용이 커집니다. 커서는 기준점부터 읽기 때문에 데이터 변동에 안정적이지만, 임의 페이지로 바로 이동할 수 없습니다.

### ② 디바운스와 요청 취소의 역할

- **디바운스 (300ms)**: 마지막 입력 후 300ms 동안 추가 입력이 없을 때만 요청을 보냅니다. 키를 누를 때마다 요청하는 낭비를 줄이며, 요청 **횟수**를 줄이는 장치입니다.
- **요청 취소 (AbortController)**: 새 요청을 보낼 때 이전 요청을 취소해서, 늦게 도착한 오래된 응답이 최신 결과를 덮어쓰는 경쟁 상태를 막습니다. 응답 **순서**를 보장하는 장치입니다.
- 디바운스만으로는 300ms 이후에 보낸 요청들 사이의 응답 순서 역전을 막지 못하므로 두 가지를 함께 사용합니다.

### ③ `limit + 1` 원리

- `limit`개가 필요할 때 `limit + 1`개를 조회합니다. 결과가 `limit`개보다 많으면 다음 페이지가 있다(`hasNext = true`)고 판단하고, 초과한 1개는 버리고 응답합니다.
- 전체 개수를 세는 `COUNT(*)` 없이 다음 페이지 존재 여부를 알 수 있어서, 커서 방식에서 비용을 줄일 수 있습니다.

### ④ `offset` · `totalPages` 계산식

```
offset     = (page - 1) × limit
totalPages = max(1, ceil(totalCount / limit))
```

- 예: `totalCount = 1000`, `limit = 10` → `totalPages = 100`. 이때 `page = 3`이면 `offset = 20`으로, 21~30번째 글을 조회합니다.
- 검색 결과가 0건이어도 `totalPages`는 1로 유지해서 페이지 번호가 0이 되지 않도록 합니다.

---

## 실습 범위

1,000건 인메모리 배열을 사용합니다. 응답 시간은 관찰값으로만 기록하며, DB 인덱스 성능 입증은 범위에 포함하지 않습니다.
