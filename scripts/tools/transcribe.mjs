/**
 * 영상·소리에서 말을 받아 적는다. 작업 폴더에 놓이고, 사람이 이렇게 부른다:
 *
 *   node transcribe.mjs <파일> [--lang ko|en|auto] [--out 말.txt]
 *
 * 왜 스크립트로 두는가: 세션이 매번 whisper 호출 코드를 새로 짜면 dtype·청크
 * 길이·타임스탬프 옵션을 하나씩 틀린다. 받아 적기는 정답이 하나뿐인 일이라
 * 매번 다시 발명할 이유가 없다.
 *
 * 인터넷도 API 키도 쓰지 않는다 — 모델을 한 번 받아 두면 그 뒤로는 이 컴퓨터
 * 안에서만 돈다. (앱 전체가 구독 로그인만 쓰고 API 키를 안 쓰는 것과 같은 규칙.)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!file || !fs.existsSync(file)) {
  console.error('쓰는 법: node transcribe.mjs <영상 또는 소리 파일> [--lang ko|en|auto] [--out 말.txt]');
  process.exit(2);
}

const lang = opt('lang', 'auto');
const outFile = opt('out', null);
const model = process.env.CREW_STT_MODEL || 'onnx-community/whisper-small';

/** ffmpeg 은 도구함에 있다. 영상이든 소리든 whisper 가 먹는 형태로 바꾼다. */
const FFMPEG = ['node_modules/ffmpeg-static/ffmpeg.exe', 'node_modules/ffmpeg-static/ffmpeg']
  .map((p) => path.resolve(p))
  .find((p) => fs.existsSync(p));
if (!FFMPEG) {
  console.error('ffmpeg 을 못 찾았습니다. 영상 도구가 아직 준비 중일 수 있습니다.');
  process.exit(3);
}

// 16kHz 모노 float — whisper 가 기대하는 그대로. 파이프가 아니라 파일로 받는다:
// 긴 영상은 stdout 버퍼를 넘겨 조용히 잘린다.
const rawFile = path.join(path.dirname(file), `.${path.basename(file)}.16k.raw`);
try {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', rawFile],
    { windowsHide: true, maxBuffer: 1 << 24 });
} catch (e) {
  console.error(`소리를 꺼내지 못했습니다: ${String(e.message).slice(0, 200)}`);
  console.error('소리가 아예 없는 영상일 수 있습니다 — 그러면 화면만 보고 말하세요.');
  process.exit(4);
}

const buf = fs.readFileSync(rawFile);
if (buf.length < 16000 * 4 * 0.3) {
  fs.rmSync(rawFile, { force: true });
  console.error('소리가 없습니다 (0.3초 미만). 화면만 보고 말하세요.');
  process.exit(5);
}
// Buffer 는 공용 풀 위의 뷰라 시작 지점이 4의 배수가 아닐 수 있다. Float32Array
// 는 그걸 거부하므로 필요할 때만 제 몫의 메모리로 옮긴다.
const bytes = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
const audio = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const seconds = audio.length / 16000;

const { pipeline, env } = await import('@huggingface/transformers');
// 모델은 도구함 밖에 둔다 — 나중에 npm install 이 node_modules 를 갈아엎어도
// 1~2백 MB 를 다시 받는 일이 없도록.
env.cacheDir = process.env.CREW_STT_CACHE
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.claude-crew', 'models');

const started = Date.now();
const asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8' });
const out = await asr(audio, {
  ...(lang === 'auto' ? {} : { language: lang === 'ko' ? 'korean' : lang === 'en' ? 'english' : lang }),
  task: 'transcribe',
  // 30초씩 끊어 듣고 5초씩 겹친다 — 겹치지 않으면 경계에 걸린 낱말이 사라진다.
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: true,
});
fs.rmSync(rawFile, { force: true });

const stamp = (t) => {
  const s = Math.max(0, Math.round(t ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const lines = (out.chunks ?? [])
  .filter((c) => c.text?.trim())
  .map((c) => `[${stamp(c.timestamp?.[0])}] ${c.text.trim()}`);
const body = lines.length ? lines.join('\n') : (out.text ?? '').trim();

if (outFile) fs.writeFileSync(outFile, `${body}\n`, 'utf8');
console.log(body);
console.error(`\n(${seconds.toFixed(0)}초 분량 · ${((Date.now() - started) / 1000).toFixed(0)}초 걸림 · ${model})`);
