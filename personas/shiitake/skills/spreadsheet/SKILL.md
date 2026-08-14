---
name: spreadsheet
description: Use whenever the user mentions a spreadsheet, Excel, xlsx, xls, csv, 표, 시트, 수불부, 정산, 합계, 피벗, or hands over a data file to clean up, cross-check, or summarise.
---

# 표·엑셀 다루기

## 0. 원본은 건드리지 않는다

읽기만 한다. 결과는 항상 **새 파일**로 쓰고 경로를 알려준다.
원본을 고쳐야 하는 상황이면 먼저 사본을 만들고, 사본을 고쳤다고 명시한다.

## 1. 먼저 구조를 파악한다

무엇을 할지 정하기 전에 읽는다. **`xlsx`(SheetJS)와 `exceljs` 는 이미 설치돼 있다** —
오피스가 공용 도구함을 작업 폴더에 연결해 두므로 `npm install` 을 하지 마라.

```js
import XLSX from 'xlsx';
const wb = XLSX.readFile('input.xlsx', { cellDates: true });
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  console.log(name, `${ref.e.r + 1}행 x ${ref.e.c + 1}열`);
  console.log(XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }).slice(0, 5));
}
```

**헤더가 1행에 있다고 가정하지 않는다.** 앞 5행을 눈으로 보고 실제 헤더 행을 찾는다.
병합 셀, 소계 행, 단위 표기("천원")가 섞여 있는지 확인한다.

읽은 결과를 사용자에게 먼저 요약한다: 시트 수, 행 수, 헤더 위치, 이상해 보이는 점.

## 2. 계산했으면 검산한다

내보내기 전에 반드시 대조하고, 그 결과를 사용자에게 말한다.

- 행 수: 입력 행 수 = 출력 행 수 + 의도적으로 제외한 행 수
- 합계: 원본 합계와 결과 합계가 일치하는가. 부동소수 오차는 반올림해서 비교한다.
- 빈 칸·`#N/A`·문자열로 들어온 숫자의 개수

안 맞으면 **맞춘 척하지 말고** 어느 행이 안 맞는지 짚어준다.

## 3. 내보내기

서식이 필요 없으면 SheetJS 로 충분하다.

```js
const out = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(out, XLSX.utils.json_to_sheet(rows), '결과');
XLSX.writeFile(out, '결과_20260813.xlsx');
```

굵게·색·열 너비·숫자 서식이 필요하면 `exceljs` 를 쓴다. 서식 규칙:

- 숫자 열은 `#,##0`, 금액은 `#,##0`, 비율은 `0.0%`. 셀에 문자열로 넣지 않는다.
- 합계 행은 굵게 + 위쪽 테두리 하나. 배경색으로 도배하지 않는다.
- 열 너비는 내용 길이에 맞춘다. 잘려 보이는 열을 남기지 않는다.
- 날짜는 실제 날짜 값으로 넣는다. `2026-08-13` 같은 문자열로 넣지 않는다.

CSV 로 달라고 하면 **UTF-8 BOM** 을 붙인다. 안 붙이면 Excel 에서 한글이 깨진다.

`Cannot find package 'xlsx'` 가 나면 도구함이 아직 준비 중인 것이다. 그때만
`npm install xlsx exceljs --no-audit --no-fund` 를 직접 해 보고, 그것도 막히면 사용자에게
알린 뒤 읽을 수 있는 만큼(CSV 등)만 처리한다.

## 4. 보고

숫자를 먼저 말한다.

```
1,842행 처리했습니다. 합계 412,900,000원 — 원본과 일치합니다.
안 맞는 행 3건: 12행(수량 공란), 45행(단가가 문자), 88행(중복).
결과: C:\...\결과_20260813.xlsx
```
