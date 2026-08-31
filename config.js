// 영수증장부 PWA 설정 (v1 싱글유저 — v2에서 온보딩으로 대체)
const CONFIG = {
  CLIENT_ID: '276935461693-7fnsuid2almh92hcoqfpnf5f76egl346.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets.readonly',
  SHEET_ID: '19cq9KqSOxq_gW3KWF78mbQUahhnrSHAra6KnzoBfn_8',
  SHEET_RANGE: '경비장부!A2:J',
  INBOX_FOLDER_ID: '1h7oty3ciPBWwHKnprN3fAjGb6C3w5bOs',
  // 경비장부 열 인덱스 (0-base) — 시트 스키마 변경 시 여기만 수정
  COL: { DATE: 0, VENDOR: 1, AMOUNT: 2, VAT: 3, CATEGORY: 4, REASON: 5, LINK: 6, RTYPE: 7, STATUS: 8, MEMO: 9 },
};
