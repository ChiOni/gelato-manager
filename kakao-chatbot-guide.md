# 스쿱 챗봇 설정 가이드

- **봇 이름**: 스쿱
- **봇 ID**: `6a48cf7a770794462a9c7449`
- **백엔드 구조**: Kakao → Vercel Edge Function → Apps Script doGet

---

## Step 1. 카카오 채널 개설

1. https://business.kakao.com 접속 → **채널 만들기**
2. 채널명: `스쿱앤십`
3. 카테고리: 음식/음료 > 디저트 카페
4. 개설 완료 후 채널 홈 URL 메모 (알바들 친구 추가용)

---

## Step 2. 채널 연결

1. https://i.kakao.com → 봇 `스쿱` 선택
2. 좌측 **배포** → **카카오톡 채널 연결** → Step 1 채널 선택

---

## Step 2.5. Vercel 배포 (최초 1회)

> Google Apps Script가 POST 302 리다이렉트로 Kakao와 직접 연결 불가 → Vercel Edge Function이 중간 프록시 역할

1. https://vercel.com 접속 → **GitHub로 계속** 로그인
2. **Add New Project** → **Import Git Repository** → `chioni/gelato-manager` 선택
3. 설정 변경 없이 **Deploy** 클릭
4. 배포 완료 후 URL 확인 (예: `https://gelato-manager-abc.vercel.app`)
5. **스킬 서버 URL**: `https://[위 URL]/api/kakao`

---

## Step 3. 스킬 8개 등록

> i.kakao.com → 스킬 탭 → 스킬 추가

**모든 스킬의 URL은 동일합니다 (Vercel URL로 변경 필요):**
```
https://[Vercel 배포 URL]/api/kakao
```
예시: `https://gelato-manager-abc.vercel.app/api/kakao`

스킬 이름이 곧 기능 구분자이므로 **이름을 아래와 정확히 동일하게** 입력해야 합니다.

| # | 스킬 이름 (정확히 입력) | 설명 |
|---|----------------------|------|
| 1 | `getWineList` | 와인 목록 조회 |
| 2 | `getWineDetail` | 와인 상세 조회 |
| 3 | `addWine` | 와인 생성 |
| 4 | `updateWine` | 와인 수정 |
| 5 | `updateWineStock` | 와인 재고 증감 |
| 6 | `getRecipeList` | 젤라또 레시피 목록 |
| 7 | `getRecipeDetail` | 젤라또 레시피 상세 |
| 8 | `addRecipe` | 젤라또 레시피 생성 |

### 각 스킬별 파라미터

파라미터는 블록 편집 화면에서 스킬 연결 시 설정합니다.

| 스킬 이름 | 파라미터 Key | 설명 |
|-----------|------------|------|
| `getWineDetail` | `wine_name` | 와인 이름 |
| `addWine` | `wine_name`, `wine_feature`, `wine_price`, `wine_stock` | 이름·특징·가격·재고 |
| `updateWine` | `wine_name`, `wine_feature`(선택), `wine_price`(선택), `wine_stock`(선택) | 수정할 항목만 |
| `updateWineStock` | `wine_name`, `quantity`(기본 1), `stock_action`(add/sub/set) | 재고 증감 |
| `getRecipeDetail` | `menu_name` | 메뉴 이름 |
| `addRecipe` | `menu_name`, `ingredients`, `feature` | 이름·재료·특징 |

---

## Step 4. 시나리오 블록 구성

> 좌측 시나리오 탭 → 블록 추가

### 웰컴 블록
```
안녕하세요! 스쿱 봇입니다 🍦🍷
```
퀵리플라이: `레시피 목록` / `와인 목록`

### 블록 목록

| 블록 이름 | 연결 스킬 | 발화 예시 |
|-----------|-----------|---------|
| 젤라또 레시피 목록 | `getRecipeList` | "레시피", "레시피 목록" |
| 젤라또 레시피 상세 | `getRecipeDetail` | "말차 레시피", "초코 레시피" |
| 젤라또 레시피 생성 | `addRecipe` | "레시피 추가", "새 레시피" |
| 와인 목록 | `getWineList` | "와인", "와인 목록" |
| 와인 상세 | `getWineDetail` | "산지오베제 상세" |
| 와인 생성 | `addWine` | "와인 추가", "새 와인" |
| 와인 수정 | `updateWine` | "산지오베제 수정" |
| 와인 재고 추가 | `updateWineStock` | "산지오베제 재고 추가" |
| 와인 재고 감소 | `updateWineStock` | "산지오베제 재고 감소" |

**재고 추가/감소 블록 파라미터:**
- 재고 추가: `stock_action` = `add`, `quantity` = `1`
- 재고 감소: `stock_action` = `sub`, `quantity` = `1`

---

## Step 5. 와인 데이터 초기 등록

Google Sheets **와인** 시트에 직접 입력:

| 이름 | 특징 | 가격 | 재고 |
|------|------|------|------|
| (와인명) | (맛/향 설명) | (숫자만, 예: 38000) | (병 수) |

---

## 완성 후 사용 예시

```
알바: 말차 레시피
봇:   🍦 말차 레시피 (1.5L 배치)
      우유 1500g · 생크림 278g · ...
      쌉쌀하고 깊은 말차 향

알바: 와인 목록
봇:   🍷 와인 목록 (5종)
      산지오베제 — 38,000원 · 재고 8병

알바: 산지오베제 재고 추가
봇:   ✅ 산지오베제 재고 업데이트
      8병 → 9병
```
