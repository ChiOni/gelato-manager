// 젤라또 관리 시스템 v2 — Google Apps Script Backend
// 배포: 확장 프로그램 > Apps Script > 배포 > 새 배포 > 웹 앱
// 액세스: 모든 사용자(익명 포함)
//
// GET 엔드포인트:
//   ?action=getProduction
//   ?action=getSales
//   ?action=getDashboard
//   ?action=addProduction&date=...&menu=...&batch=...&amount=...&milk=...&cream=...&memo=...
//   ?action=addSaleBatch&uploadDate=...&fileName=...&data=[{date,menu,qty,amount},...]
//   ?action=getRecipes
//
// POST 엔드포인트:
//   action=saveRecipes  body: data=<JSON string>

function doGet(e) {
  const p = e.parameter;
  try {
    let result;
    switch (p.action) {
      case 'getProduction':  result = getProduction(); break;
      case 'getSales':       result = getSales();       break;
      case 'getDashboard':   result = getDashboard();   break;
      case 'addProduction':  result = addProduction(p); break;
      case 'addSaleBatch':   result = addSaleBatch(p);  break;
      case 'getRecipes':     result = getRecipes();     break;
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
      case 'saveRecipes': result = saveRecipes(p.data); break;
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
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// ─── Read ──────────────────────────────────────────────────────────────────

function getProduction() {
  const sheet = getSheet('생산기록',
    ['날짜', '메뉴', '배치수', '생산량(g)', '우유(L)', '생크림(ml)', '메모', '타임스탬프']);
  return { data: sheetToJson(sheet) };
}

function getSales() {
  const sheet = getSheet('판매기록',
    ['업로드일', '파일명', '판매일', '메뉴', '수량', '금액', '타임스탬프']);
  const data = sheetToJson(sheet);

  // 토스포스 '상품주문상세내역' 시트 자동 병합
  const posSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('상품주문상세내역');
  if (posSheet) {
    sheetToJson(posSheet).forEach(function(row) {
      // 취소·환불 제외
      const status = String(row['결제상태'] || '').trim();
      if (status.includes('취소') || status.includes('환불')) return;

      // 날짜: Date 객체 또는 문자열 처리
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

      // '실판매금액' 포함 컬럼 탐색 (헤더에 줄바꿈 포함 가능)
      let amount = 0;
      Object.keys(row).forEach(function(key) {
        if (String(key).includes('실판매금액')) {
          amount = parseFloat(String(row[key]).replace(/[,\s]/g, '')) || 0;
        }
      });
      if (amount <= 0) return; // 0원·음수(환불) 제외

      data.push({
        '업로드일': dateStr,
        '파일명': '상품주문상세내역',
        '판매일': dateStr,
        '메뉴': menu,
        '수량': qty,
        '금액': amount,
        '타임스탬프': ''
      });
    });
  }

  return { data: data };
}

function getDashboard() {
  const prodData  = sheetToJson(getSheet('생산기록',
    ['날짜', '메뉴', '배치수', '생산량(g)', '우유(L)', '생크림(ml)', '메모', '타임스탬프']));
  const salesData = sheetToJson(getSheet('판매기록',
    ['업로드일', '파일명', '판매일', '메뉴', '수량', '금액', '타임스탬프']));

  const now       = new Date();
  const today     = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  const thisMonth = today.slice(0, 7);

  let monthlyTotal = 0, todayTotal = 0, todayCount = 0;
  const monthlySalesByMonth = {};
  const menuSummaryThisMonth = {};

  salesData.forEach(r => {
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

  const monthlyProd   = prodData.filter(r => String(r['날짜'] || '').startsWith(thisMonth)).length;
  const totalProdG    = prodData.reduce((s, r) => s + (parseFloat(r['생산량(g)']) || 0), 0);

  return {
    monthlySales: monthlyTotal,
    todaySales:   todayTotal,
    todayCount,
    monthlyProduction: monthlyProd,
    totalProductionG:  totalProdG,
    menuSummary:       menuSummaryThisMonth,
    monthlySalesByMonth
  };
}

// ─── Write ─────────────────────────────────────────────────────────────────

function addProduction(p) {
  const sheet = getSheet('생산기록',
    ['날짜', '메뉴', '배치수', '생산량(g)', '우유(L)', '생크림(ml)', '메모', '타임스탬프']);
  sheet.appendRow([
    p.date,
    p.menu,
    parseInt(p.batch)   || 1,
    parseFloat(p.amount) || 0,
    parseFloat(p.milk)   || 0,
    parseFloat(p.cream)  || 0,
    p.memo || '',
    new Date().toISOString()
  ]);
  return { success: true };
}

function addSaleBatch(p) {
  const sheet = getSheet('판매기록',
    ['업로드일', '파일명', '판매일', '메뉴', '수량', '금액', '타임스탬프']);

  let sales = [];
  try { sales = JSON.parse(p.data || '[]'); } catch (e) { return { error: 'JSON parse error' }; }

  const ts         = new Date().toISOString();
  const uploadDate = p.uploadDate || ts.slice(0, 10);
  const fileName   = p.fileName   || '';

  const rows = sales.map(s => [
    uploadDate,
    fileName,
    String(s.date || uploadDate).slice(0, 10),
    s.menu   || '',
    parseInt(s.qty)      || 1,
    parseFloat(s.amount) || 0,
    ts
  ]);

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
  }
  return { success: true, count: rows.length };
}

// ─── 레시피 설정 ────────────────────────────────────────────────────────────

function getRecipes() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('설정');
  if (!sheet) return { recipes: null };
  const val = sheet.getRange('B1').getValue();
  return { recipes: val || null };
}

function saveRecipes(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('설정');
  if (!sheet) {
    sheet = ss.insertSheet('설정');
    sheet.getRange('A1').setValue('recipes');
  }
  sheet.getRange('B1').setValue(data || '');
  return { success: true };
}
