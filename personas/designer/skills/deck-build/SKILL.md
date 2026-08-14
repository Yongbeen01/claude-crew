---
name: deck-build
description: Use when the user asks for a presentation, slides, a deck, PPT, PPTX, 발표자료, 보고자료, or 제안서. Covers outlining, building the .pptx file, and handing it back.
---

# 발표 자료 만들기

## 1. 목차 먼저

파일을 만들기 전에 목차를 채팅으로 보여주고 동의를 받는다. 형식:

```
1. 제목 — 이 장에서 하려는 말
2. …
```

한 장에 메시지 하나. 사용자가 장수를 지정했으면 그 수를 정확히 지킨다.

## 2. 파일 만들기

작업 폴더(cwd)에 만든다. **`pptxgenjs` 는 이미 설치돼 있다** — 오피스가 공용 도구함을
작업 폴더에 연결해 두므로 `npm install` 을 하지 마라. 바로 `build-deck.mjs` 를 쓰고
`node build-deck.mjs` 로 실행하면 된다. 최소 골격:

```js
import pptxgen from 'pptxgenjs';
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_16x9';
pptx.defineSlideMaster({
  title: 'BASE',
  background: { color: 'FFFFFF' },
  objects: [{ line: { x: 0.5, y: 1.15, w: 9.0, h: 0, line: { color: 'D9D2C5', width: 1 } } }],
});
const s = pptx.addSlide({ masterName: 'BASE' });
s.addText('한 장의 메시지', { x: 0.5, y: 0.45, w: 9, h: 0.6, fontSize: 28, bold: true, color: '1F1D1A' });
s.addText([{ text: '근거 한 줄', options: { bullet: true } }], { x: 0.5, y: 1.4, w: 9, h: 3.5, fontSize: 16, color: '3A3733' });
await pptx.writeFile({ fileName: '제안서.pptx' });
```

`Cannot find package 'pptxgenjs'` 가 나면 도구함이 아직 준비 중이거나 받지 못한 것이다.
그때만 `npm install pptxgenjs --no-audit --no-fund` 를 직접 해 본다. 그것도 막히면
(오프라인·사내 프록시) 사용자에게 그 사실을 알리고, 대신 목차와 각 장 원고를 마크다운으로
정리해서 준다. 조용히 포기하지 않는다.

## 3. 디자인 기본값

- 배경은 흰색 또는 아주 옅은 미색. 검정 배경은 요청받았을 때만.
- 본문 서체는 맑은 고딕 / Pretendard 계열. 제목만 크게, 본문은 16pt 이상.
- 색은 강조 하나만 정해서 끝까지 쓴다. 장마다 색이 바뀌면 산만해진다.
- 보라색 그라데이션, 무의미한 아이콘 행렬, 3D 도형은 쓰지 않는다.
- 표는 5행을 넘기면 요약하거나 부록으로 뺀다.

## 4. 마무리

만든 파일의 **절대경로**와 장수, 그리고 사용자가 직접 확인해야 할 부분(숫자 출처, 빈 칸)을
두세 문장으로 알린다. 파일을 열어 확인하라고 시키지 말고, 무엇이 들어 있는지 먼저 말한다.
