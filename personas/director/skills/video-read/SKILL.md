---
name: video-read
description: Use when the user gives a video — a YouTube or TikTok link, a 유튜브/틱톡 URL, or an attached .mp4/.mov/.webm file — and wants to know what is in it. Covers pulling frames, captions and metadata, and reading them.
---

# 영상을 실제로 열어 보기

영상은 "읽을" 수 없습니다. **화면을 그림으로 만들어 눈으로 보고**, **말은 자막으로 읽습니다.**
아래 두 가지 중 상황에 맞는 것을 씁니다. 어느 쪽도 안 되면 안 됐다고 말하세요 — 제목만 보고
내용을 지어내면 안 됩니다.

## 도구가 어디 있는지

작업 폴더(cwd) 기준 상대 경로입니다. 오피스가 공용 도구함을 연결해 두었습니다.

- ffmpeg: `node_modules/ffmpeg-static/ffmpeg.exe`
- yt-dlp: `node_modules/youtube-dl-exec/bin/yt-dlp.exe`

(Windows가 아니면 `.exe` 없이 같은 경로입니다.)

파일이 아직 없으면 **처음 부른 직후라 받는 중**입니다. 사용자에게 "영상 도구를 받고 있어요,
1분쯤 걸립니다" 라고 한 줄 말하고, 잠시 뒤 다시 확인하세요. 계속 없으면 그 사실을 말합니다.

---

## A. 파일을 붙여 준 경우 — 가장 확실한 길

붙인 파일은 `inbox/` 에 들어옵니다.

**1) 길이부터 봅니다.** ffprobe 는 없습니다. ffmpeg 이 stderr 로 알려줍니다.

```bash
node_modules/ffmpeg-static/ffmpeg.exe -i "inbox/<파일명>" 2>&1 | grep Duration
```

**2) 고르게 잘라 냅니다.** 길이를 N등분해서 12장 안팎이면 충분합니다.
(예: 60초 영상 → 5초마다 = `fps=1/5`)

```bash
node_modules/ffmpeg-static/ffmpeg.exe -y -loglevel error -i "inbox/<파일명>" \
  -vf "fps=1/5,scale=640:-1" -frames:v 12 "frames/f_%02d.jpg"
```

**3) 뽑은 그림을 Read 로 봅니다.** 한 장씩 열어 무엇이 보이는지 적습니다. 각 그림이 몇 초
지점인지 계산해 두세요 (`f_03.jpg` = 5초 간격이면 15초 지점).

**소리는 못 듣습니다.** 화면에 자막이 박혀 있으면 그림에서 읽히지만, 말한 내용은 알 수
없습니다. 그 한계를 사용자에게 말하세요.

---

## B. 링크를 준 경우 (유튜브 · 틱톡)

### B-1. 먼저 yt-dlp 로 정보와 자막을 받습니다 (빠르고 정확)

```bash
node_modules/youtube-dl-exec/bin/yt-dlp.exe \
  --ffmpeg-location "node_modules/ffmpeg-static/ffmpeg.exe" \
  --skip-download --write-subs --write-auto-subs --sub-langs "ko,en" --sub-format vtt \
  -o "src.%(ext)s" \
  --print-to-file "%(title)s|%(uploader)s|%(duration)s|%(description)s" info.txt \
  "<URL>"
```

- `info.txt` = 제목·올린이·길이(초)·설명글.
- `src.ko.vtt` / `src.en.vtt` = 자막. **있으면 이게 내용의 핵심 재료입니다.** 타임스탬프가
  붙어 있으니 시간대별 흐름을 여기서 만드세요.
- `--sub-langs` 에 언어를 많이 넣지 마세요. 여러 개를 연달아 받으면 429(요청 과다)가 납니다.

자막이 없다고 나오면 그건 그 영상에 자막이 없는 것입니다. 그대로 다음 단계로 갑니다.

### B-2. 화면은 브라우저로 봅니다

영상 파일 자체를 내려받는 건 **막혀 있는 경우가 많습니다** (유튜브 403, 틱톡은 응답 거부).
그래서 화면은 사람이 보듯 브라우저에서 봅니다. `browser_*` 도구가 있으면 그걸 씁니다.

1. `browser_navigate` 로 URL 을 엽니다. 5초쯤 기다립니다(`browser_wait_for`).
2. `browser_evaluate` 로 길이를 봅니다: `() => document.querySelector('video')?.duration`
3. 보고 싶은 시점마다 아래를 실행해 **영상을 그 지점에 세웁니다.**

```js
async (t) => {
  const v = document.querySelector('video');
  v.pause();
  v.currentTime = t;
  await new Promise((r) => {
    const done = () => { v.removeEventListener('seeked', done); r(); };
    v.addEventListener('seeked', done);
    setTimeout(r, 3000);
  });
  return v.currentTime;
}
```

4. `browser_take_screenshot` 으로 **`video` 요소만** 찍습니다 (주변 UI 는 내용이 아닙니다).
5. 저장된 그림을 Read 로 봅니다.

전체 길이의 10% / 35% / 60% / 85% 지점 4장이면 흐름이 보입니다. 짧은 숏폼은 6~8장까지
늘리세요. 맨 앞·맨 끝은 검은 화면인 경우가 많아 피합니다.

### B-3. 막혔을 때

- **틱톡에서 슬라이더 퍼즐(봇 확인)이 뜨면** 사용자에게 부탁하세요: "브라우저 창에 뜬 확인
  퍼즐을 한 번만 맞춰 주세요. 다음부터는 안 뜹니다." 브라우저는 사용자 화면에 보이고 있고,
  그 프로필은 이 사람 자리에 남습니다.
- **`browser_*` 도구가 아예 없으면** 화면을 볼 수 없습니다. "작업 과정 지켜보기" 를 켜 달라고
  한 줄로 부탁하세요. 그때까지는 자막·설명글로 아는 것만 말합니다.
- **자막도 없고 화면도 못 봤으면** 요약하지 마세요. 무엇이 막혔는지 한 줄로 말하고 끝냅니다.

---

## 정리해서 돌려줄 때

```
한 줄 요약.

0:00–0:07  무슨 장면인지
0:07–0:19  …

눈에 띄는 것: 후킹 문구, 반복되는 장면, 화면에 박힌 자막 등
```

마지막에 **어디까지 직접 봤는지** 한 줄 붙입니다.
예: "화면은 4장(2·7·11·16초)을 봤고, 말한 내용은 자막 기준입니다."
