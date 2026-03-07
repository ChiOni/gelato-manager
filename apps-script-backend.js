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
//
// POST body action=
//   saveMetadata  data=<JSON>   → 메타 저장 (자동 백업 스냅샷 포함)
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
      case 'addProduction':     result = addProduction(p);       break;
      case 'updateProduction':  result = updateProduction(p);    break;
      case 'listBackups':       result = listBackups();          break;
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
  const p = e.parameter;
  try {
    let result;
    switch (p.action) {
      case 'saveMetadata': result = saveMetadata(p.data); break;
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
  if (!p.time) return { error: 'Missing time' };
  sheet.getRange(row, 1).setValue(_toKstStr(p.time));
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
