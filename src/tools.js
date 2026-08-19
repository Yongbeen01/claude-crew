import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HOME, config } from './config.js';

/**
 * 앱이 부리는 두 개의 바깥 프로그램 — `claude` 와 `git` — 이 어디 있는지.
 *
 * 예전에는 이름만 넘기고 PATH 에 맡겼다. 설치한 사람 컴퓨터에서는 그게 잘
 * 됐는데, 그건 설치 스크립트가 자기 세션의 PATH 를 고쳐 놨기 때문이었다.
 * 남의 컴퓨터에서 바탕화면 아이콘으로 켜면 그 PATH 가 없다. 그러면:
 *
 *   · 세션이 뜨자마자 죽어 "종료됨" 으로 보인다 (로그아웃처럼 보이는 정체)
 *   · 남은 한도 칸이 비어 있다
 *   · 업데이트 확인이 조용히 실패해 "받기" 띠가 영영 안 뜬다
 *
 * 셋 다 같은 원인이고, 화면에는 서로 다른 고장으로 보인다. 그래서 PATH 에
 * 기대지 않고 우리가 직접 찾아 **절대 경로**로 부른다. 찾은 폴더는
 * process.env.PATH 앞에 붙여 두어, 자식 프로세스와 claude 가 다시 부르는
 * 것들도 같은 길을 쓰게 한다.
 */

const isWin = process.platform === 'win32';
const exe = (p) => (isWin ? [`${p}.exe`, `${p}.cmd`, `${p}.bat`, p] : [p]);

/** 설치 방식마다 다른, 흔히 놓이는 자리들. */
function candidates(name) {
  const out = [];
  const add = (...parts) => out.push(path.join(...parts));
  if (name === 'claude') {
    add(HOME, '.local', 'bin');
    add(HOME, 'AppData', 'Local', 'Programs', 'claude');
    add(HOME, 'AppData', 'Roaming', 'npm');          // npm -g 로 깔았을 때
    add(HOME, '.bun', 'bin');
    add('/usr/local/bin');
  } else if (name === 'git') {
    add(DATA_DIR, 'runtime', 'git', 'cmd');          // 설치 스크립트가 받아 둔 무설치본
    add('C:', '\\Program Files', 'Git', 'cmd');
    add('C:', '\\Program Files (x86)', 'Git', 'cmd');
    add(HOME, 'AppData', 'Local', 'Programs', 'Git', 'cmd');
    add('/usr/bin');
  } else if (name === 'node') {
    add(DATA_DIR, 'runtime', 'node');
  }
  return out;
}

/** PATH 에 있으면 그걸 쓴다 — 사용자가 직접 깐 것을 앞지르지 않는다. */
function onPath(name) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], {
      windowsHide: true, timeout: 5000, encoding: 'utf8',
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

function search(name) {
  const found = onPath(name);
  if (found) return found;
  for (const dir of candidates(name)) {
    for (const file of exe(name)) {
      const full = path.join(dir, file);
      try { if (fs.existsSync(full)) return full; } catch { /* 접근 못 하면 다음 자리 */ }
    }
  }
  return null;
}

const cache = new Map();

/**
 * 이 프로그램의 절대 경로. 못 찾으면 이름을 그대로 돌려준다 — 그때는 예전처럼
 * PATH 에 걸어 보기라도 하는 편이 아무것도 안 하는 것보다 낫다.
 */
export function bin(name) {
  const hit = cache.get(name);
  // 캐시가 가리키던 파일이 사라졌으면(업데이트·재설치) 다시 찾는다
  if (hit && (hit === name || fs.existsSync(hit))) return hit;

  const override = name === 'claude' && process.env.CLAUDE_BIN ? process.env.CLAUDE_BIN : null;
  const found = override ?? search(name) ?? name;
  cache.set(name, found);

  // 찾은 폴더를 PATH 앞에 붙인다. claude 가 자기 하위 도구를 부를 때도 같은
  // 길을 쓰게 하려는 것 — 자식은 process.env 를 물려받는다.
  if (found !== name) {
    const dir = path.dirname(found);
    const sep = isWin ? ';' : ':';
    const parts = String(process.env.PATH ?? '').split(sep);
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) {
      process.env.PATH = `${dir}${sep}${process.env.PATH ?? ''}`;
    }
  }
  return found;
}

export const claudeBin = () => bin('claude');
export const gitBin = () => bin('git');

/** 찾았는지 못 찾았는지 — 화면이 사실대로 말할 수 있게. */
export function toolsStatus() {
  const claude = bin('claude');
  const git = bin('git');
  return {
    claude: { found: claude !== 'claude', path: claude === 'claude' ? '' : claude },
    git: { found: git !== 'git', path: git === 'git' ? '' : git },
    configured: config.claudeBin !== 'claude' ? config.claudeBin : '',
  };
}
