import { execFile } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * Windows 알림.
 *
 * 조용한 배너와 긴급 알림은 다른 물건이다. 기본 토스트는 5초쯤 떠 있다가 알림
 * 센터로 들어가 버리는데, "시간 다 됐다" 는 그렇게 지나가면 안 되는 종류의
 * 말이다. 그래서 급한 것은 `scenario="reminder"` 로 띄운다 — 사용자가 직접
 * 치울 때까지 화면에 남고 알람 소리가 반복된다. 리마인더는 버튼이 하나 있어야
 * 그 성격이 유지되므로 "확인" 을 단다.
 *
 * 못 하는 것 하나: 집중 지원(방해 금지)을 뚫는 `scenario="alarm"` 은 앱을
 * 알람 앱으로 등록해야 쓸 수 있다. 여기서는 등록하지 않으므로, 방해 금지가
 * 켜져 있으면 알림 센터로 들어간다.
 *
 * 문구는 명령줄이 아니라 환경변수로 넘긴다. 할 일 이름에는 따옴표도 한글도
 * 들어오는데, 그걸 스크립트 문자열에 끼워 넣으면 따옴표 하나로 스크립트가
 * 깨지거나 임의의 명령이 되어 버린다.
 */

const HOST = path.join(ROOT, 'scripts', 'toast.ps1');

/**
 * @param {{title?: string, body: string, urgent?: boolean}} opts
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function notify({ title = 'claude-crew', body, urgent = false } = {}) {
  if (process.platform !== 'win32' || !body) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HOST.replace(/\\/g, '/')],
      {
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          CREW_TOAST_TITLE: String(title),
          CREW_TOAST_BODY: String(body),
          CREW_TOAST_URGENT: urgent ? '1' : '0',
          // 버튼 글자도 여기로 — 스크립트 파일은 ASCII 로 유지해야 한다
          CREW_TOAST_OK: '확인',
        },
      },
      (err, stdout) => {
        const out = String(stdout ?? '').trim();
        resolve(err ? { ok: false, error: err.message } : { ok: out.startsWith('ok'), error: out });
      },
    );
  });
}

/**
 * 한 사람이 하는 말을 Windows 알림으로 내보낸다.
 *
 * 화면을 보고 있는지는 **묻지 않는다**. 탭이 열려 있는지로 알림을 가리면, 정작
 * 알림이 필요한 상황(자리를 비웠다) 에서만 조용해진다 — 그건 알림이 아니라
 * 알림처럼 생긴 것이다.
 *
 * 대신 같은 말이 두 번 나가는 것만 막는다. 두 가지 경로가 같은 사건을 두고
 * 겹치기 때문이다: 타이머가 스스로 띄우는 알림과, 그 직후 토끼가 같은 내용을
 * 말해서 나가는 알림. 앞엣것이 나간 지 얼마 안 됐으면 뒤엣것은 접는다.
 */
const lastSpoken = new Map(); // personId -> { body, at }
const lastRaised = new Map(); // personId -> at   (앱 타이머 / notify 도구)

/** 토씨 하나 안 틀린 같은 말이 두 번 뜨는 것만 막는다. */
const SAME_TEXT_MS = 60_000;
/**
 * 앱이 알린 사건을 사람이 말로 옮겨 또 알리는 것을 막는 창.
 *
 * 길게 잡는다 — 타이머 알림이 뜨고, 그 poke 를 받은 토끼가 같은 말을 하기까지
 * 모델이 생각하는 시간이 든다. 그 사이가 짧으면 사건 하나에 알림이 두 번 뜬다.
 */
const AFTER_RAISED_MS = 45_000;
/**
 * 한 턴이 여러 문단으로 나뉘어 나올 때, 그 턴을 알림 하나로 접는 창.
 *
 * 짧게 잡는다 — 이건 "한 답을 여러 조각으로 말했다" 를 접는 것이지, 나중에
 * 하는 **다른** 말까지 막으라는 뜻이 아니다. 무조건 알리라고 만든 자리에서
 * 진짜 새 소식을 조용히 버리면 그게 가장 나쁜 실패다.
 */
const SAME_TURN_MS = 12_000;

export async function notifyFor(personId, { title, body, urgent = false, kind = 'speak' } = {}) {
  const text = String(body ?? '').trim();
  if (!text) return { ok: false, error: 'empty' };

  const now = Date.now();
  if (personId && kind === 'speak') {
    const prev = lastSpoken.get(personId);
    if (prev && prev.body === text && now - prev.at < SAME_TEXT_MS) return { ok: false, error: 'dup' };
    if (prev && now - prev.at < SAME_TURN_MS) return { ok: false, error: 'same-turn' };
    if (now - (lastRaised.get(personId) ?? 0) < AFTER_RAISED_MS) return { ok: false, error: 'echo' };
  }

  const r = await notify({ title, body: text, urgent });
  if (personId) {
    if (kind === 'speak') lastSpoken.set(personId, { body: text, at: Date.now() });
    else lastRaised.set(personId, Date.now());
  }
  return r;
}

/** 사람이 나가면 그 사람의 기록도 지운다. */
export function forgetToasts(personId) {
  lastSpoken.delete(personId);
  lastRaised.delete(personId);
}
