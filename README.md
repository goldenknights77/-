# 유튜브 채널 조회수 모니터

등록한 유튜브 채널들(최대 약 200개)을 대상으로, 최근 24시간 내 업로드된 영상 중
지정한 조회수(20만/50만/100만) 이상인 콘텐츠만 필터링해서 보여주는 웹 대시보드입니다.

## 주요 기능

- **설정**: YouTube Data API v3 키를 서버(D1)에 안전하게 저장 (화면에는 마스킹 표시)
- **채널 관리**: 채널 URL / @핸들 / 채널ID를 줄바꿈으로 대량 붙여넣기 등록 (최대 약 200개)
  - `youtube.com/@handle`, `youtube.com/channel/UCxxxx`, `youtube.com/c/이름`, `youtube.com/@handle` 등 다양한 형식 자동 인식
- **오늘의 체크**: 등록된 활성 채널 전체를 대상으로 최근 24시간 내 업로드 영상을 조회
  - 진행 상황을 실시간 프로그레스바로 표시 (백엔드 배치 스텝 방식, 타임아웃 없이 200개도 안전하게 처리)
- **조회수 필터**: 20만+ / 50만+ / 100만+ 버튼으로 원하는 기준 이상만 필터링
- **히스토리**: 날짜별 실행 기록 저장 (D1), 과거 결과를 언제든 다시 조회/삭제 가능
- **쿼터 절약**: 채널 정보/영상 통계는 50개씩 배치 호출, 재생목록은 최신순 조회 중 기준 시각보다 오래된 영상을 만나면 조회 중단 → YouTube API 무료 할당량(10,000 units/일) 내에서 200개 채널 매일 체크 가능

## 기술 스택

- [Hono](https://hono.dev/) (Cloudflare Workers/Pages용 경량 웹 프레임워크)
- Cloudflare Pages + D1 (SQLite 기반 서버리스 DB)
- 순수 HTML/CSS/JavaScript 프론트엔드 (프레임워크 없이 바닐라 JS로 구현)

## 로컬 개발

```bash
npm install
npm run build
npx wrangler d1 migrations apply webapp-db --local
npx wrangler pages dev dist
```

## 배포

```bash
npm run build
npm run deploy
```

## YouTube Data API v3 키 발급 방법

1. https://console.cloud.google.com/ 접속 → 새 프로젝트 생성
2. "API 및 서비스 → 라이브러리"에서 `YouTube Data API v3` 검색 후 활성화
3. "API 및 서비스 → 사용자 인증 정보 → API 키 만들기"
4. (권장) 키 제한을 `YouTube Data API v3`로만 제한
5. 발급된 키를 웹 대시보드의 **설정** 탭에 붙여넣고 저장

무료 할당량은 하루 10,000 units이며, 채널 200개를 매일 체크해도 보통 수백 units 수준만 소모됩니다.
