// 젤라또 관리 시스템 v3 — Google Apps Script Backend
// 배포: bash deploy-backend.sh (clasp push --force && clasp deploy --deploymentId ...)
// 액세스: 모든 사용자(익명 포함)
//
// GET ?action=
//   getMetadata          → 재료/옵션/레시피 메타 전체
//   getProduction        → 생산기록 전체 (_row 포함)
//   getSales             → 판매기록 (판매기록 + 상품주문상세내역 병합)
//   getDashboard         → 대시보드 집계
//   addProduction&time=&option=&recipe=&batches=  → 생산 추가
//   updateProduction&row=&time=                   → 생산시각 수정
//   listBackups          → 백업 이력 목록 조회
//   getWines             → 와인 목록 전체
//   getWineDetail&name=  → 와인 상세 (이름/특징/가격/재고)
//   getWorkInstructions  → 오늘 업무 지시 조회
//
// POST body action=
//   saveMetadata  data=<JSON>      → 메타 저장 (자동 백업 스냅샷 포함)
//   addWine       name=&feature=&price=&stock=  → 와인 추가
//   updateWine    row=&[name=&feature=&price=&stock=]  → 와인 수정
//   deleteWine    row=             → 와인 삭제
//   saveWorkInstructions content=&author=  → 오늘 업무 지시 저장
//
// POST body (Content-Type: application/json) — 카카오 스킬서버
//   action=getWineList             → 와인 목록 리스트 카드
//   action=getWineDetail           → 와인 상세 basicCard
//   action=updateWineStock         → 재고 증감 처리
//   action=getRecipeList           → 젤라또 레시피 메뉴 버튼
//   action=getRecipeDetail         → 레시피 상세 카드
//   action=getWorkInstructions     → 오늘 업무 지시 텍스트
//
// 일일 자동 백업 설정 (최초 1회 Apps Script 에디터에서 실행):
//   setupDailyBackup()  → 매일 자정 백업 트리거 등록

function doGet(e) {
  const p = e.parameter;
  try {
    let result;
    switch (p.action) {
      case 'getMetadata':       result = getMetadata();          break;
      case 'getProduction':     result = getProduction();        break;
      case 'getSales':          result = getSales();             break;
      case 'getDashboard':      result = getDashboard();         break;
      case 'addProduction':        result = addProduction(p);          break;
      case 'updateProduction':     result = updateProduction(p);       break;
      case 'deleteProduction':     result = deleteProduction(p);       break;
      case 'listBackups':          result = listBackups();             break;
      case 'getWines':             result = getWines();                break;
      case 'getWineDetail':        result = getWineDetail(p);          break;
      case 'getRecipes':           result = getRecipes();              break;
      case 'getRecipesForKakao':  result = getRecipesForKakao();      break;
      case 'getWorkInstructions':  result = getWorkInstructions();     break;
      case 'kakaoSkill':           result = _handleKakaoSkillGet(p);   break;
      default:
        result = { error: 'Invalid action: ' + p.action };
    }
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  // 카카오 스킬서버: JSON 바디 요청 (charset 포함 가능)
  if (e.postData && e.postData.mimeType && e.postData.mimeType.indexOf('application/json') >= 0) {
    return handleKakaoSkill(e);
  }

  const p = e.parameter;
  try {
    let result;
    switch (p.action) {
      case 'saveMetadata':          result = saveMetadata(p.data);          break;
      case 'addWine':               result = addWine(p);                    break;
      case 'updateWine':            result = updateWine(p);                 break;
      case 'deleteWine':            result = deleteWine(p);                 break;
      case 'saveWorkInstructions':  result = saveWorkInstructions(p);       break;
      default:
        result = { error: 'Invalid action: ' + p.action };
    }
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── 유틸 ──────────────────────────────────────────────────────────────────

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function sheetToJson(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  return data.slice(1).map(function(row) {
    const obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  });
}

// ─── 메타데이터 (재료 / 옵션 / 레시피) ────────────────────────────────────

function getMetadata() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('설정');
  if (!sheet) return { metadata: null };
  const val = sheet.getRange('B1').getValue();
  return { metadata: val ? String(val) : null };
}

function saveMetadata(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('설정');
  if (!sheet) {
    sheet = ss.insertSheet('설정');
    sheet.getRange('A1').setValue('metadata');
  }
  sheet.getRange('B1').setValue(data || '');
  // 저장 시 백업 스냅샷도 동시 기록
  _appendBackup(data || '', ss);
  return { success: true };
}

// ─── 생산기록 ───────────────────────────────────────────────────────────────

function getProductionSheet() {
  const headers = ['생산시각', '옵션', '레시피', '배치수', '타임스탬프'];
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  let sheet     = ss.getSheetByName('생산기록');
  if (!sheet) {
    sheet = ss.insertSheet('생산기록');
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    // 헤더가 구버전(날짜/메뉴/…)인 경우 새 시트로 교체
    const firstCell = sheet.getRange('A1').getValue();
    if (String(firstCell).trim() !== '생산시각') {
      ss.deleteSheet(sheet);
      sheet = ss.insertSheet('생산기록');
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function getProduction() {
  const sheet = getProductionSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return { data: [] };
  const headers = data[0];
  const rows = data.slice(1).map(function(row, i) {
    const obj = {};
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    obj._row = i + 2; // 스프레드시트 행 번호 (헤더=1, 데이터 시작=2)
    return obj;
  });
  return { data: rows };
}

function _toKstStr(timeParam) {
  try {
    var dt = timeParam ? new Date(timeParam) : new Date();
    return Utilities.formatDate(dt, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  } catch(e) {
    return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  }
}

function addProduction(p) {
  const sheet = getProductionSheet();
  sheet.appendRow([
    _toKstStr(p.time),
    p.option  || '',
    p.recipe  || '',
    parseInt(p.batches) || 1,
    new Date().toISOString()
  ]);
  return { success: true };
}

function updateProduction(p) {
  const sheet = getProductionSheet();
  const row   = parseInt(p.row);
  if (!row || row < 2) return { error: 'Invalid row: ' + p.row };
  if (p.time)    sheet.getRange(row, 1).setValue(_toKstStr(p.time));
  if (p.option !== undefined)  sheet.getRange(row, 2).setValue(p.option);
  if (p.recipe !== undefined)  sheet.getRange(row, 3).setValue(p.recipe);
  if (p.batches !== undefined) sheet.getRange(row, 4).setValue(parseInt(p.batches) || 1);
  return { success: true };
}

function deleteProduction(p) {
  const sheet = getProductionSheet();
  const row   = parseInt(p.row);
  if (!row || row < 2) return { error: 'Invalid row: ' + p.row };
  sheet.deleteRow(row);
  return { success: true };
}

// ─── 판매기록 ───────────────────────────────────────────────────────────────

function getSales() {
  const sheet = getSheet('판매기록',
    ['업로드일', '파일명', '판매일', '메뉴', '수량', '금액', '타임스탬프']);
  const data = sheetToJson(sheet);

  // 토스포스 '상품주문상세내역' 시트 자동 병합
  const posSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('상품주문상세내역');
  if (posSheet) {
    sheetToJson(posSheet).forEach(function(row) {
      const status = String(row['결제상태'] || '').trim();
      if (status.includes('취소') || status.includes('환불')) return;

      const dateVal = row['주문기준일자'];
      let dateStr;
      try {
        dateStr = (dateVal instanceof Date)
          ? Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd')
          : String(dateVal).slice(0, 10);
      } catch(e) { dateStr = ''; }

      const menu = String(row['상품명'] || '').trim();
      if (!menu) return;

      const qty = parseInt(row['수량']) || 1;
      let amount = 0;
      Object.keys(row).forEach(function(key) {
        if (String(key).includes('실판매금액')) {
          amount = parseFloat(String(row[key]).replace(/[,\s]/g, '')) || 0;
        }
      });
      if (amount <= 0) return;

      data.push({
        '업로드일': dateStr,
        '파일명':   '상품주문상세내역',
        '판매일':   dateStr,
        '메뉴':     menu,
        '수량':     qty,
        '금액':     amount,
        '타임스탬프': ''
      });
    });
  }

  return { data: data };
}

// ─── 대시보드 집계 ──────────────────────────────────────────────────────────

function getDashboard() {
  const prodData  = getProduction().data;
  const salesData = getSales().data;

  const now       = new Date();
  const today     = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  const thisMonth = today.slice(0, 7);

  let monthlyTotal = 0, todayTotal = 0, todayCount = 0;
  const monthlySalesByMonth  = {};
  const menuSummaryThisMonth = {};

  salesData.forEach(function(r) {
    const d      = String(r['판매일'] || r['업로드일'] || '').slice(0, 10);
    const amount = parseFloat(r['금액']) || 0;
    const month  = d.slice(0, 7);

    monthlySalesByMonth[month] = (monthlySalesByMonth[month] || 0) + amount;

    if (month === thisMonth) {
      monthlyTotal += amount;
      const menu = r['메뉴'] || '기타';
      if (!menuSummaryThisMonth[menu]) menuSummaryThisMonth[menu] = { count: 0, amount: 0 };
      menuSummaryThisMonth[menu].count  += parseInt(r['수량']) || 1;
      menuSummaryThisMonth[menu].amount += amount;
    }
    if (d === today) { todayTotal += amount; todayCount++; }
  });

  // 생산 집계 (v3 스키마: 생산시각 기준)
  const monthlyProd  = prodData.filter(function(r) {
    return String(r['생산시각'] || '').slice(0, 7) === thisMonth;
  }).length;
  const totalBatches = prodData.reduce(function(s, r) {
    return s + (parseInt(r['배치수']) || 0);
  }, 0);

  return {
    monthlySales:       monthlyTotal,
    todaySales:         todayTotal,
    todayCount,
    monthlyProduction:  monthlyProd,
    totalBatches,
    menuSummary:        menuSummaryThisMonth,
    monthlySalesByMonth
  };
}

// ─── 백업 ──────────────────────────────────────────────────────────────────

var BACKUP_KEEP = 30; // 최대 보관 스냅샷 수

function _getBackupSheet(ss) {
  var sheet = ss.getSheetByName('백업이력');
  if (!sheet) {
    sheet = ss.insertSheet('백업이력');
    sheet.appendRow(['타임스탬프', '메타데이터 JSON']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function _appendBackup(json, ss) {
  try {
    var bSheet = _getBackupSheet(ss || SpreadsheetApp.getActiveSpreadsheet());
    var ts = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    bSheet.appendRow([ts, json]);
    // 오래된 백업 정리: 헤더 포함 BACKUP_KEEP+1 초과 시 오래된 행 삭제
    var lastRow = bSheet.getLastRow();
    if (lastRow > BACKUP_KEEP + 1) {
      bSheet.deleteRows(2, lastRow - BACKUP_KEEP - 1);
    }
  } catch(e) { /* 백업 실패해도 저장은 정상 진행 */ }
}

function listBackups() {
  var bSheet = _getBackupSheet(SpreadsheetApp.getActiveSpreadsheet());
  var rows = sheetToJson(bSheet);
  // 최신순으로 반환 (타임스탬프만, JSON은 생략)
  return {
    backups: rows.reverse().map(function(r) {
      return { ts: r['타임스탬프'], size: String(r['메타데이터 JSON'] || '').length };
    })
  };
}

// 일일 자동 백업 트리거 등록 (Apps Script 에디터에서 1회 실행)
function setupDailyBackup() {
  // 기존 gelato 트리거 제거 후 재등록
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyBackup')
    .timeBased().everyDays(1).atHour(0).create();
  return { success: true, message: '매일 자정 자동 백업 트리거가 등록되었습니다.' };
}

function dailyBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('설정');
  if (!sheet) return;
  var val = sheet.getRange('B1').getValue();
  if (val) _appendBackup(String(val), ss);
}

// ─── 와인 관리 ─────────────────────────────────────────────────────────────

function getWineSheet() {
  return getSheet('와인', ['이름', '특징', '가격', '재고', '타임스탬프']);
}

function getWines() {
  return { data: sheetToJson(getWineSheet()) };
}

function getWineDetail(p) {
  const rows = sheetToJson(getWineSheet());
  const wine = rows.find(function(r) {
    return String(r['이름']).trim() === String(p.name || '').trim();
  });
  return wine ? { data: wine } : { error: '해당 와인을 찾을 수 없습니다: ' + p.name };
}

function addWine(p) {
  const sheet = getWineSheet();
  sheet.appendRow([
    p.name    || '',
    p.feature || '',
    p.price   || '',
    parseInt(p.stock) || 0,
    new Date().toISOString()
  ]);
  return { success: true };
}

function updateWine(p) {
  const sheet = getWineSheet();
  const row   = parseInt(p.row);
  if (!row || row < 2) return { error: 'Invalid row: ' + p.row };
  if (p.name    !== undefined) sheet.getRange(row, 1).setValue(p.name);
  if (p.feature !== undefined) sheet.getRange(row, 2).setValue(p.feature);
  if (p.price   !== undefined) sheet.getRange(row, 3).setValue(p.price);
  if (p.stock   !== undefined) sheet.getRange(row, 4).setValue(parseInt(p.stock) || 0);
  sheet.getRange(row, 5).setValue(new Date().toISOString());
  return { success: true };
}

function deleteWine(p) {
  const sheet = getWineSheet();
  const row   = parseInt(p.row);
  if (!row || row < 2) return { error: 'Invalid row: ' + p.row };
  sheet.deleteRow(row);
  return { success: true };
}

// ─── 업무 지시 ─────────────────────────────────────────────────────────────

function getWorkInstructionSheet() {
  return getSheet('업무지시', ['날짜', '내용', '작성자', '타임스탬프']);
}

function getWorkInstructions() {
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const rows  = sheetToJson(getWorkInstructionSheet());
  const todays = rows.filter(function(r) {
    return String(r['날짜']).slice(0, 10) === today;
  });
  return { data: todays, date: today };
}

function saveWorkInstructions(p) {
  const sheet = getWorkInstructionSheet();
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  sheet.appendRow([today, p.content || '', p.author || '치원', new Date().toISOString()]);
  return { success: true };
}

// ─── 레시피 관리 ────────────────────────────────────────────────────────────

var RECIPE_DEFAULTS = [
  { 이름: '바나나',       재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 바나나퓨레 225g',          특징: '달콤하고 부드러운 바나나 풍미' },
  { 이름: '생크림밀크',   재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g',                          특징: '깔끔하고 진한 밀크 베이스' },
  { 이름: '레몬요거트',   재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 요거트베이스 150g · 레몬즙 50g', 특징: '상큼한 요거트, 레몬 여운' },
  { 이름: '호지차한라봉', 재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 호지차파우더 30g · 한라봉농축액 50g', 특징: '구수한 호지차 + 한라봉 산뜻함' },
  { 이름: '아몬드',       재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 아몬드페이스트 225g',     특징: '고소하고 진한 아몬드' },
  { 이름: '말차',         재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 말차파우더 195g',         특징: '쌉쌀하고 깊은 말차 향' },
  { 이름: '딸기소르베',   재료: '물 800g · 설탕 300g · 포도당 80g · 안정제 8g · 딸기퓨레 600g · 레몬즙 30g',                                               특징: '과일향 가득한 소르베 (유제품 없음)' },
  { 이름: '초코',         재료: '우유 1500g · 생크림 278g · 탈지분유 66g · 설탕 276g · 포도당 43g · 덱스트로스 82g · 안정제 11g · 다크초코파우더 120g · 코코아버터 30g', 특징: '진하고 강렬한 다크초코' }
];

function getRecipeSheet() {
  var sheet = getSheet('레시피', ['이름', '재료', '특징', '타임스탬프']);
  if (sheet.getLastRow() <= 1) {
    RECIPE_DEFAULTS.forEach(function(r) {
      sheet.appendRow([r['이름'], r['재료'], r['특징'], new Date().toISOString()]);
    });
  }
  return sheet;
}

function getRecipes() {
  return { data: sheetToJson(getRecipeSheet()) };
}

// 챗봇용 — 설정 시트 메타데이터에서 레시피 읽기 (웹앱과 동일한 소스)
function getRecipesForKakao() {
  try {
    var ss   = SpreadsheetApp.getActiveSpreadsheet();
    var raw  = ss.getSheetByName('설정').getRange('B1').getValue();
    var meta = JSON.parse(raw);

    var ingMap = {};
    (meta.ingredients || []).forEach(function(i) { ingMap[i.id] = i; });

    var recipes = (meta.recipes || []).map(function(r) {
      var 재료 = (r.ingredients || []).map(function(i) {
        var ing = ingMap[i.id];
        return ing ? (ing.name + ' ' + i.qty + (ing.unit || 'g')) : (i.id + ' ' + i.qty);
      }).join(' · ');
      return { 이름: r.name, 재료: 재료, 특징: '' };
    });

    return { data: recipes };
  } catch (e) {
    return { error: e.message, data: [] };
  }
}

function _findRecipeRow(sheet, name) {
  var data    = sheet.getDataRange().getValues();
  var nameIdx = data[0].indexOf('이름');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameIdx]).trim() === String(name).trim()) return i + 1;
  }
  return -1;
}

function addRecipeRow(p) {
  getRecipeSheet().appendRow([p.name || '', p.ingredients || '', p.feature || '', new Date().toISOString()]);
  return { success: true };
}

function updateRecipeRow(p) {
  var sheet = getRecipeSheet();
  var row   = _findRecipeRow(sheet, p.name || '');
  if (row < 0) return { error: '레시피를 찾을 수 없습니다: ' + p.name };
  var hdrs = sheet.getDataRange().getValues()[0];
  if (p.ingredients !== undefined) sheet.getRange(row, hdrs.indexOf('재료') + 1).setValue(p.ingredients);
  if (p.feature !== undefined)     sheet.getRange(row, hdrs.indexOf('특징') + 1).setValue(p.feature);
  sheet.getRange(row, hdrs.indexOf('타임스탬프') + 1).setValue(new Date().toISOString());
  return { success: true };
}

function deleteRecipeRow(p) {
  var sheet = getRecipeSheet();
  var row   = _findRecipeRow(sheet, p.name || '');
  if (row < 0) return { error: '레시피를 찾을 수 없습니다: ' + p.name };
  sheet.deleteRow(row);
  return { success: true };
}

// ─── 카카오 스킬서버 ────────────────────────────────────────────────────────

function handleKakaoSkill(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    // 스킬 이름으로 액션 구분 (오픈빌더 스킬명 = action.name)
    var action = (body.action && body.action.name) ? body.action.name : (e.parameter.ka || '');
    var params = (body.action && body.action.params) ? body.action.params : {};
    var result;

    switch (action) {
      // 와인 조회
      case 'getWineList':       result = kakaoWineList();                                                                  break;
      case 'getWineDetail':     result = kakaoWineDetail(params.wine_name || '');                                          break;
      // 와인 CRUD
      case 'addWine':           result = kakaoAddWine(params);                                                             break;
      case 'updateWine':        result = kakaoUpdateWine(params);                                                          break;
      case 'deleteWine':        result = kakaoDeleteWine(params.wine_name || '');                                          break;
      // 와인 재고 빠른 업데이트
      case 'updateWineStock':   result = kakaoUpdateWineStock(params.wine_name || '', params.quantity || '1', params.stock_action || 'add'); break;
      // 레시피 조회
      case 'getRecipeList':     result = kakaoRecipeList();                                                                break;
      case 'getRecipeDetail':   result = kakaoRecipeDetail(params.menu_name || '');                                        break;
      // 레시피 CRUD
      case 'addRecipe':         result = kakaoAddRecipe(params);                                                           break;
      case 'updateRecipe':      result = kakaoUpdateRecipe(params);                                                        break;
      case 'deleteRecipe':      result = kakaoDeleteRecipe(params.menu_name || '');                                        break;
      default:
        result = _kakaoSimpleText('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');
    }
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify(_kakaoSimpleText('오류가 발생했습니다: ' + err.toString())))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function kakaoWineList() {
  var wines = sheetToJson(getWineSheet());
  if (!wines.length) {
    return _kakaoSimpleText('등록된 와인이 없습니다.\n관리자에게 문의해주세요.');
  }
  var items = wines.map(function(w) {
    var stock  = parseInt(w['재고']) || 0;
    var stockLabel = stock > 0 ? stock + '병' : '❌ 품절';
    return {
      title:       String(w['이름']),
      description: String(w['가격']) + '원 · 재고 ' + stockLabel
    };
  });
  // 리스트 카드는 5개 제한
  var pages = [];
  for (var i = 0; i < items.length; i += 5) {
    pages.push(items.slice(i, i + 5));
  }
  // 첫 페이지 반환 (여러 페이지는 카루셀로 묶기 어려워 단순 처리)
  return {
    version: '2.0',
    template: {
      outputs: [{
        listCard: {
          header: { title: '🍷 와인 목록 (' + wines.length + '종)' },
          items:  pages[0],
          buttons: [{
            label:       '와인 상세 보기',
            action:      'message',
            messageText: '와인 상세'
          }]
        }
      }],
      quickReplies: wines.slice(0, 10).map(function(w) {
        return {
          label:       String(w['이름']),
          action:      'block',
          messageText: String(w['이름']) + ' 상세'
        };
      })
    }
  };
}

function kakaoWineDetail(wineName) {
  var rows = sheetToJson(getWineSheet());
  var wine = rows.find(function(r) {
    return String(r['이름']).trim() === String(wineName).trim();
  });
  if (!wine) {
    return _kakaoSimpleText('❓ "' + wineName + '" 와인을 찾을 수 없습니다.');
  }
  var stock = parseInt(wine['재고']) || 0;
  var desc  = [
    '🍇 ' + String(wine['특징'] || ''),
    '',
    '💰 가격: ' + String(wine['가격'] || '') + '원',
    '📦 재고: ' + (stock > 0 ? stock + '병' : '❌ 품절')
  ].join('\n');
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title:       String(wine['이름']),
          description: desc,
          buttons: [
            { label: '재고 추가 (+1)', action: 'block', messageText: String(wine['이름']) + ' 재고 추가' },
            { label: '재고 감소 (-1)', action: 'block', messageText: String(wine['이름']) + ' 재고 감소' }
          ]
        }
      }]
    }
  };
}

function kakaoUpdateWineStock(wineName, quantityStr, stockAction) {
  var sheet = getWineSheet();
  var data  = sheet.getDataRange().getValues();
  var headers = data[0];
  var nameIdx  = headers.indexOf('이름');
  var stockIdx = headers.indexOf('재고');
  var tsIdx    = headers.indexOf('타임스탬프');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameIdx]).trim() === String(wineName).trim()) {
      var current  = parseInt(data[i][stockIdx]) || 0;
      var qty      = parseInt(quantityStr) || 1;
      var newStock;
      if (stockAction === 'add')      newStock = current + qty;
      else if (stockAction === 'sub') newStock = Math.max(0, current - qty);
      else                            newStock = qty; // 'set'
      sheet.getRange(i + 1, stockIdx + 1).setValue(newStock);
      sheet.getRange(i + 1, tsIdx + 1).setValue(new Date().toISOString());
      return _kakaoSimpleText(
        '✅ ' + wineName + ' 재고 업데이트\n' +
        current + '병 → ' + newStock + '병'
      );
    }
  }
  return _kakaoSimpleText('❓ "' + wineName + '" 와인을 찾을 수 없습니다.');
}

function kakaoRecipeList() {
  var rows    = sheetToJson(getRecipeSheet());
  var replies = rows.map(function(r) {
    return { label: String(r['이름']), action: 'block', messageText: String(r['이름']) + ' 레시피' };
  });
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: '🍦 어떤 메뉴의 레시피를 확인할까요?' } }],
      quickReplies: replies
    }
  };
}

function kakaoRecipeDetail(menuName) {
  var name = menuName.replace(' 레시피', '').trim();
  var rows = sheetToJson(getRecipeSheet());
  var r    = rows.find(function(row) { return String(row['이름']).trim() === name; });
  if (!r) return _kakaoSimpleText('❓ "' + name + '" 레시피를 찾을 수 없습니다.');
  return {
    version: '2.0',
    template: {
      outputs: [{
        basicCard: {
          title:       '🍦 ' + name + ' 레시피 (1.5L 배치)',
          description: String(r['재료']) + '\n\n' + String(r['특징'])
        }
      }],
      quickReplies: [
        { label: '다른 레시피', action: 'block', messageText: '레시피 목록' },
        { label: '메인 메뉴',   action: 'block', messageText: '메인 메뉴' }
      ]
    }
  };
}

function kakaoAddRecipe(params) {
  if (!params.menu_name) return _kakaoSimpleText('❗ 레시피 이름을 입력해주세요.');
  addRecipeRow({ name: params.menu_name, ingredients: params.ingredients || '', feature: params.feature || '' });
  return _kakaoSimpleText('✅ "' + params.menu_name + '" 레시피가 추가되었습니다.');
}

function kakaoUpdateRecipe(params) {
  if (!params.menu_name) return _kakaoSimpleText('❗ 레시피 이름을 입력해주세요.');
  var result = updateRecipeRow({ name: params.menu_name, ingredients: params.ingredients, feature: params.feature });
  if (result.error) return _kakaoSimpleText('❌ ' + result.error);
  return _kakaoSimpleText('✅ "' + params.menu_name + '" 레시피가 수정되었습니다.');
}

function kakaoDeleteRecipe(menuName) {
  if (!menuName) return _kakaoSimpleText('❗ 레시피 이름을 입력해주세요.');
  var result = deleteRecipeRow({ name: menuName });
  if (result.error) return _kakaoSimpleText('❌ ' + result.error);
  return _kakaoSimpleText('🗑️ "' + menuName + '" 레시피가 삭제되었습니다.');
}

function kakaoAddWine(params) {
  if (!params.wine_name) return _kakaoSimpleText('❗ 와인 이름을 입력해주세요.');
  addWine({ name: params.wine_name, feature: params.wine_feature || '', price: params.wine_price || '', stock: params.wine_stock || '0' });
  return _kakaoSimpleText('✅ "' + params.wine_name + '" 와인이 추가되었습니다.');
}

function kakaoUpdateWine(params) {
  if (!params.wine_name) return _kakaoSimpleText('❗ 와인 이름을 입력해주세요.');
  var sheet = getWineSheet();
  var data  = sheet.getDataRange().getValues();
  var hdrs  = data[0];
  var nameIdx = hdrs.indexOf('이름');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameIdx]).trim() === String(params.wine_name).trim()) {
      if (params.wine_feature !== undefined) sheet.getRange(i + 1, hdrs.indexOf('특징') + 1).setValue(params.wine_feature);
      if (params.wine_price   !== undefined) sheet.getRange(i + 1, hdrs.indexOf('가격') + 1).setValue(params.wine_price);
      if (params.wine_stock   !== undefined) sheet.getRange(i + 1, hdrs.indexOf('재고') + 1).setValue(parseInt(params.wine_stock) || 0);
      sheet.getRange(i + 1, hdrs.indexOf('타임스탬프') + 1).setValue(new Date().toISOString());
      return _kakaoSimpleText('✅ "' + params.wine_name + '" 와인 정보가 수정되었습니다.');
    }
  }
  return _kakaoSimpleText('❌ "' + params.wine_name + '" 와인을 찾을 수 없습니다.');
}

function kakaoDeleteWine(wineName) {
  if (!wineName) return _kakaoSimpleText('❗ 와인 이름을 입력해주세요.');
  var sheet = getWineSheet();
  var data  = sheet.getDataRange().getValues();
  var nameIdx = data[0].indexOf('이름');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameIdx]).trim() === String(wineName).trim()) {
      sheet.deleteRow(i + 1);
      return _kakaoSimpleText('🗑️ "' + wineName + '" 와인이 삭제되었습니다.');
    }
  }
  return _kakaoSimpleText('❌ "' + wineName + '" 와인을 찾을 수 없습니다.');
}


// GET 기반 카카오 스킬 라우터 (Vercel Edge 프록시에서 호출)
// doPost가 302 리다이렉트되는 구조 우회: Vercel → doGet?action=kakaoSkill&skillAction=X
function _handleKakaoSkillGet(p) {
  var action = p.skillAction || '';
  switch (action) {
    case 'getWineList':     return kakaoWineList();
    case 'getWineDetail':   return kakaoWineDetail(p.wine_name || '');
    case 'addWine':         return kakaoAddWine({ wine_name: p.wine_name, wine_feature: p.wine_feature, wine_price: p.wine_price, wine_stock: p.wine_stock });
    case 'updateWine':      return kakaoUpdateWine({ wine_name: p.wine_name, wine_feature: p.wine_feature, wine_price: p.wine_price, wine_stock: p.wine_stock });
    case 'updateWineStock': return kakaoUpdateWineStock(p.wine_name || '', p.quantity || '1', p.stock_action || 'add');
    case 'getRecipeList':   return kakaoRecipeList();
    case 'getRecipeDetail': return kakaoRecipeDetail(p.menu_name || '');
    case 'addRecipe':       return kakaoAddRecipe({ menu_name: p.menu_name, ingredients: p.ingredients, feature: p.feature });
    default:                return _kakaoSimpleText('❓ 알 수 없는 요청입니다.\n메뉴에서 선택해주세요!');
  }
}

function _kakaoSimpleText(text) {
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text: text } }],
      quickReplies: [
        { label: '🍦 레시피',    action: 'block', messageText: '레시피 목록' },
        { label: '🍷 와인 목록', action: 'block', messageText: '와인 목록' }
      ]
    }
  };
}
