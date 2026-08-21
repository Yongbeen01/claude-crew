/**
 * 무엇을 물어보고, 무엇을 그냥 하게 둘 것인가.
 *
 * 예전에는 반대로 물었다 — "이 도구가 허용 목록에 있나?" 목록에 없으면 전부
 * 카드가 떴고, 파일 하나 고치는 일마다 사람이 눌러 줘야 했다. 그 결과는
 * 안전이 아니라 **무감각**이다. 카드가 스무 개 쌓이면 사람은 읽지 않고 누른다.
 * 정작 위험한 하나도 같이 눌린다.
 *
 * 그래서 질문을 뒤집는다. 기본은 **허용**이고, 아래 세 가지에 걸릴 때만
 * 물어본다:
 *
 *   1. machine — 이 컴퓨터에 되돌리기 어려운 변화 (지우기·포맷·레지스트리·
 *      서비스·전역 설치·받아서 바로 실행)
 *   2. secret  — 자격이나 개인정보가 든 파일 (.env, 키, 인증서, .ssh, .aws)
 *   3. env     — 환경변수를 통째로 쏟거나, 이름이 비밀처럼 생긴 값을 건드림
 *
 * 걸리는 일이 드물어야 카드 한 장이 무게를 가진다. 규칙을 늘리고 싶어질
 * 때마다 이걸 기억할 것 — 카드가 흔해지는 순간 이 파일은 아무 일도 안 한다.
 */

/** 자격·개인정보가 든 파일 이름. */
const SECRET_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|\.credentials\.json|credentials(\.json)?|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i;

/** 확장자만 봐도 비밀인 것. */
const SECRET_EXT = /\.(pem|pfx|p12|key|keystore|jks|ppk)$/i;

/** 통째로 비밀이 든 폴더. */
const SECRET_DIR = /[\\/](\.ssh|\.aws|\.gnupg|\.azure|\.kube|gcloud|brands|secrets?)[\\/]/i;

/**
 * 건드리면 이 컴퓨터가 달라지는 자리.
 *
 * 일부러 앞을 고정하지 않는다 — 명령줄 한가운데 박혀 있어도 (`notepad
 * C:\Windows\System32\…`) 걸려야 하고, 공백이 든 `"C:\Program Files\…"` 는
 * 낱말로 쪼개면 짝이 끊긴다. 대신 읽기만 하는 명령도 함께 걸린다:
 * 밖에서 읽기와 쓰기를 구별할 방법이 없으니, 이 세 폴더에서는 한 번 더
 * 물어보는 쪽을 고른다.
 */
const SYSTEM_DIR = /[a-z]:[\\/](windows|program files( \(x86\))?|programdata)[\\/]/i;

/** 이름이 비밀처럼 생긴 환경변수. */
const SECRET_NAME = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i;

/**
 * 되돌리기 어려운 명령들. 짝은 [무엇에 걸리는가, 사람에게 뭐라고 말할까].
 *
 * 일부러 좁게 적었다. `rm` 이 아니라 `rm -rf`, `git push` 가 아니라
 * `git push --force` 다 — 평범한 쪽까지 잡으면 위의 무감각으로 되돌아간다.
 */
const HEAVY = [
  [/\brm\s+-[a-z]*[rf]/i, '파일·폴더를 통째로 지웁니다'],
  [/\b(rmdir|rd)\s+\/s\b/i, '폴더를 통째로 지웁니다'],
  [/\bdel\s+\/[sq]\b/i, '파일을 물어보지 않고 지웁니다'],
  [/Remove-Item\b[^|;]*-Recurse/i, '폴더를 통째로 지웁니다'],
  [/\b(format|mkfs|diskpart|fdisk)\b/i, '디스크를 건드립니다'],
  [/\bgit\s+push\b[^|;\n]*(--force|-f\b)/i, '남의 커밋을 덮어쓸 수 있는 강제 push 입니다'],
  [/\bgit\s+reset\s+--hard\b/i, '작업 중인 변경을 되돌릴 수 없게 버립니다'],
  [/\bgit\s+clean\s+-[a-z]*f/i, '추적되지 않는 파일을 지웁니다'],
  [/\b(shutdown|Restart-Computer|Stop-Computer)\b/i, '컴퓨터를 끄거나 다시 켭니다'],
  [/\breg\s+(add|delete|import)\b|\bregedit\b/i, '레지스트리를 고칩니다'],
  [/\bsetx\b/i, '환경변수를 영구히 바꿉니다'],
  [/\bnet\s+(user|localgroup)\b/i, '계정을 건드립니다'],
  [/\bnetsh\b/i, '네트워크 설정을 바꿉니다'],
  [/\bschtasks\b/i, '예약 작업을 건드립니다'],
  [/\bsc\s+(create|delete|config|stop|start)\b/i, '윈도우 서비스를 건드립니다'],
  [/\b(takeown|icacls|cacls)\b/i, '파일 권한을 바꿉니다'],
  [/Set-ExecutionPolicy/i, 'PowerShell 실행 정책을 바꿉니다'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add|un|uninstall|remove)\b[^|;\n]*\s-g\b/i, '전역 패키지를 설치·제거합니다'],
  [/\bnpm\s+publish\b/i, '패키지를 공개 저장소에 올립니다'],
  [/\b(choco|winget|scoop)\s+(install|uninstall)\b/i, '프로그램을 설치·제거합니다'],
  [/\bpip\s+(install|uninstall)\b/i, '파이썬 패키지를 설치·제거합니다'],
  [/(curl|wget|iwr|Invoke-WebRequest)[^|\n]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression)/i,
    '인터넷에서 받은 것을 곧바로 실행합니다'],
  [/\bdocker\b[^|;\n]*\bprune\b/i, '도커 자원을 통째로 정리합니다'],
];

/** 환경을 통째로 쏟는 명령. */
const ENV_DUMP = [
  /(^|[\s;&|(])(env|printenv)(\s|$)/i,
  /Get-ChildItem\s+env:/i,
  /\b(gci|ls|dir)\s+env:/i,
];

const s = (v) => (typeof v === 'string' ? v : '');

/** 이 경로가 비밀을 담고 있나. */
function isSecretPath(p) {
  const v = s(p);
  if (!v) return false;
  const norm = v.replace(/\//g, '\\');
  return SECRET_FILE.test(norm) || SECRET_EXT.test(norm) || SECRET_DIR.test(`${norm}\\`);
}

function isSystemPath(p) {
  return SYSTEM_DIR.test(s(p).replace(/\//g, '\\'));
}

/** 명령줄 안에 비밀 파일 이름이 섞여 있나 (`cat .env` 같은 것). */
function mentionsSecret(cmd) {
  return s(cmd)
    .split(/[\s"'`=]+/)
    .some((word) => word.length > 2 && isSecretPath(word));
}

/**
 * 물어봐야 하는 일인가.
 * @returns {{ risky: boolean, kind?: 'machine'|'secret'|'env', why?: string }}
 */
export function assess(tool, input = {}) {
  const safe = { risky: false };

  if (tool === 'Bash' || tool === 'BashOutput' || tool === 'KillShell') {
    const cmd = s(input.command);
    if (!cmd) return safe;

    for (const [re, why] of HEAVY) {
      if (re.test(cmd)) return { risky: true, kind: 'machine', why };
    }
    if (ENV_DUMP.some((re) => re.test(cmd))) {
      return { risky: true, kind: 'env', why: '환경변수를 통째로 출력합니다' };
    }
    if (SECRET_NAME.test(cmd)) {
      return { risky: true, kind: 'env', why: '비밀처럼 보이는 값이 명령에 들어 있습니다' };
    }
    if (mentionsSecret(cmd)) {
      return { risky: true, kind: 'secret', why: '자격이 든 파일을 건드립니다' };
    }
    if (isSystemPath(cmd)) {
      return { risky: true, kind: 'machine', why: '윈도우·프로그램 폴더를 건드립니다' };
    }
    return safe;
  }

  // 파일을 건드리는 도구들. 읽기는 비밀일 때만, 쓰기는 비밀이거나 시스템 자리일 때.
  const p = s(input.file_path || input.path || input.notebook_path);
  if (p) {
    if (isSecretPath(p)) {
      const reading = tool === 'Read' || tool === 'NotebookRead';
      return {
        risky: true,
        kind: 'secret',
        why: reading ? '자격이 든 파일을 읽습니다' : '자격이 든 파일을 고칩니다',
      };
    }
    if (tool !== 'Read' && tool !== 'NotebookRead' && isSystemPath(p)) {
      return { risky: true, kind: 'machine', why: '윈도우·프로그램 폴더의 파일을 고칩니다' };
    }
  }

  return safe;
}
