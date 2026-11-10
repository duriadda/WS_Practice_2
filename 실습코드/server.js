/**
 * 웹서비스설계 9주차 실습 · 백엔드 API 서버 (Node.js Express + 1,000건 대량 데이터셋)
 * 3학년 전공심화:
 *   1) 방어적 파라미터 파싱 (문자열 타입 확인, 양의 정수만 허용, Math.min 상한)
 *   2) ORDER BY 화이트리스트 매핑 (Object.hasOwn으로 상속 속성 차단 & id DESC 동점자 결합)
 *   3) 오프셋 페이징 API (/api/posts) + 표준 meta Envelope
 *   4) 커서 기반(Keyset) 페이징 API (/api/posts/cursor) + 제목·본문 검색
 *
 * 실행 방법:
 *   1) npm install
 *   2) npm start                 (일반 실행)
 *      npm run start:slow        (느린 네트워크 실험: API 응답을 1.5~3초 지연)
 *   3) 브라우저에서 http://localhost:3000 접속
 */

const express = require('express');
const app = express();
const PORT = 3000;

// [수정] 느린 네트워크 실험용 인위적 지연 (기본 0 = 끔)
// 지연 시간 = DELAY_MS/2 + 랜덤(0 ~ DELAY_MS/2) → 먼저 보낸 요청이 나중에 도착하는 역전도 재현 가능
const DELAY_MS = Math.max(0, Number.parseInt(process.env.DELAY_MS ?? '0', 10) || 0);

const OFFSET_MAX_LIMIT = 100;
const CURSOR_MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const MAX_SEARCH_LENGTH = 100;

app.use(express.static(__dirname)); // 현재 폴더의 index.html 정적 서빙
app.use(express.json());

// 1,000건의 대용량 더미 게시글 데이터 생성 (1~1000)
const TOPICS = [
  'B-Tree 인덱스 구조와 LIKE %kw% 검색 튜닝 실무',
  '커서 기반(Keyset) 페이지네이션 O(log N) 탐색 원리',
  'ORDER BY SQL Injection과 화이트리스트 매핑 방어',
  'InnoDB 버퍼 풀과 LIMIT OFFSET Cache Thrashing',
  'AbortController를 이용한 비동기 Race Condition 방어',
  '300ms 디바운스(Debounce)와 프론트엔드 입력 최적화',
  'URLSearchParams와 history.pushState 뒤로가기 동기화',
  'InnoDB MVCC 메커니즘과 COUNT(*) 전수 스캔 병목',
  '복합 인덱스(Compound Index) 컬럼 순서의 황금률',
  'Redis 분산 캐시를 활용한 카운트 캐싱 아키텍처',
  'RESTful JSON 페이징 Envelope 규격 표준화',
  'ElasticSearch 역색인(Inverted Index)과 N-gram 전문 검색'
];
const AUTHORS = ['이경수', '김철수', '이영희', '박민수', '정다은', '최준호', '강서연', '윤성호'];

const POSTS = Array.from({ length: 1000 }, (_, i) => {
  const id = 1000 - i;
  const topic = TOPICS[i % TOPICS.length];
  const author = AUTHORS[i % AUTHORS.length];
  const views = Math.floor(Math.random() * 5000) + 10;
  return {
    id,
    title: `[#${id}] ${topic}`,
    content: `게시글 ${id}번의 상세 본문 데이터입니다. DB 인덱스와 페이징 최적화를 실습합니다.`,
    author,
    views,
    createdAt: `2026-${(10 - Math.floor(i / 150)).toString().padStart(2, '0')}-${((i % 28) + 1).toString().padStart(2, '0')}`
  };
});

// [수정] 커서 API용 id DESC 정렬본 — 생성 순서에 의존하지 않고 정렬 기준을 명시적으로 고정
const POSTS_BY_ID_DESC = [...POSTS].sort((a, b) => b.id - a.id);

// 화이트리스트 정렬 정의 (동점자 방지 id 결합)
// ※ 더미 데이터의 createdAt은 id 순서와 단조 관계가 아니므로 최신/오래된순은 id 기준으로 정렬
const SORT_WHITELIST = Object.freeze({
  latest: (a, b) => b.id - a.id,
  oldest: (a, b) => a.id - b.id,
  views: (a, b) => (b.views !== a.views ? b.views - a.views : b.id - a.id)
});

// ==========================================
// [수정] 파라미터 파싱 유틸
// ==========================================

// 같은 키가 여러 번 오면(?search=a&search=b) 배열이 되므로 문자열만 허용
function toSingleString(raw) {
  return typeof raw === 'string' ? raw : '';
}

// '12'처럼 숫자로만 된 양의 정수만 허용. '0', '-1', 'abc', '2abc', '1e3' → fallback
function parsePositiveInt(raw, fallback) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : fallback;
}

// Object.hasOwn: 프로토타입 체인(__proto__, constructor, toString 등)을 조회하지 않음
function resolveSortKey(raw) {
  return typeof raw === 'string' && Object.hasOwn(SORT_WHITELIST, raw) ? raw : 'latest';
}

function normalizeSearch(raw) {
  return toSingleString(raw).trim().toLowerCase().slice(0, MAX_SEARCH_LENGTH);
}

// WHERE (title LIKE '%kw%' OR content LIKE '%kw%')
function matchesSearch(post, search) {
  if (!search) return true;
  return post.title.toLowerCase().includes(search) || post.content.toLowerCase().includes(search);
}

function elapsedMs(startTime) {
  const diff = process.hrtime(startTime);
  return Number((diff[0] * 1000 + diff[1] / 1e6).toFixed(2));
}

// [수정] 느린 네트워크 실험용 지연 미들웨어 (DELAY_MS > 0 일 때만 동작)
app.use('/api', async (req, res, next) => {
  if (DELAY_MS > 0) {
    const ms = Math.floor(DELAY_MS / 2 + Math.random() * (DELAY_MS / 2));
    res.setHeader('X-Debug-Delay', `${ms}ms`);
    await new Promise(resolve => setTimeout(resolve, ms));
  }
  next();
});

// ==========================================
// 1. 오프셋 기반 페이지네이션 API
// GET /api/posts?page=1&limit=10&sort=views&search=인덱스
// ==========================================
app.get('/api/posts', (req, res) => {
  const startTime = process.hrtime();

  // 파라미터 정제 및 방어 코딩
  const page = parsePositiveInt(req.query.page, 1);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), OFFSET_MAX_LIMIT);
  const search = normalizeSearch(req.query.search);
  const sortKey = resolveSortKey(req.query.sort);

  // 1) 검색 필터링 (WHERE title LIKE ? OR content LIKE ?)
  const filtered = POSTS.filter(p => matchesSearch(p, search));

  // 2) 화이트리스트 정렬 (ORDER BY ...)
  filtered.sort(SORT_WHITELIST[sortKey]);

  // 3) 오프셋 계산 및 데이터 슬라이싱
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const safePage = Math.min(page, totalPages); // 범위를 넘는 page는 마지막 페이지로 보정
  const offset = (safePage - 1) * limit;
  const items = filtered.slice(offset, offset + limit);

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      page: safePage,
      limit,
      totalCount,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
      sort: sortKey, // [수정] 실제 적용된 정렬 키 (잘못된 값이면 latest)
      search,        // [수정] 실제 적용된 검색어
      executionTimeMs
    }
  });
});

// ==========================================
// 2. 커서 기반(Keyset) 페이지네이션 API
// GET /api/posts/cursor?cursor=950&limit=10&search=인덱스
// 정렬은 id DESC 고정 (커서 = 마지막으로 받은 글의 id)
// ==========================================
app.get('/api/posts/cursor', (req, res) => {
  const startTime = process.hrtime();

  const cursor = parsePositiveInt(req.query.cursor, null);
  const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_LIMIT), CURSOR_MAX_LIMIT);
  const search = normalizeSearch(req.query.search);

  // [수정] 검색 조건 + 커서 조건을 함께 적용하고 limit + 1개까지만 조회
  // SELECT ... WHERE (title LIKE ? OR content LIKE ?) AND id < ? ORDER BY id DESC LIMIT limit + 1
  const fetched = [];
  for (const post of POSTS_BY_ID_DESC) {
    if (cursor !== null && post.id >= cursor) continue; // 커서 조건: id < cursor
    if (!matchesSearch(post, search)) continue;          // 검색 조건
    fetched.push(post);
    if (fetched.length === limit + 1) break;             // limit + 1개 모이면 탐색 중단
  }

  // limit + 1번째 글이 있으면 다음 페이지 존재 (COUNT(*) 불필요). 초과분 1개는 응답에서 제외
  const hasNext = fetched.length > limit;
  const items = hasNext ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasNext ? items[items.length - 1].id : null;

  const executionTimeMs = elapsedMs(startTime);
  res.setHeader('X-Response-Time', `${executionTimeMs}ms`);
  res.json({
    items,
    meta: {
      cursor,
      nextCursor,
      limit,
      fetchedCount: fetched.length, // [수정] limit + 1 조회 결과 확인용
      hasNext,
      search,
      order: 'id DESC',
      executionTimeMs
    }
  });
});

// [수정] 정의되지 않은 API 경로는 JSON 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: { message: '존재하지 않는 API입니다.' } });
});

// [수정] 에러 핸들러: 기본 HTML 에러 페이지의 스택 트레이스·서버 경로 노출 방지
app.use((err, req, res, next) => {
  console.error('[server error]', err);
  res.status(500).json({ error: { message: '서버 내부 오류가 발생했습니다.' } });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 웹서비스설계 9주차 3학년 전공 실습 서버 구동 완료`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`📦 데이터: 1,000건의 인메모리 게시글 로드 완료`);
  if (DELAY_MS > 0) console.log(`🐢 지연 모드: API 응답 ${DELAY_MS / 2}~${DELAY_MS}ms 지연`);
  console.log(`====================================================`);
});
