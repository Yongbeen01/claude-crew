# Phase 0 스파이크 — 결과

설계에서 미검증이던 3가지를 실제로 돌려 확인했다. 세 개 다 통과했으므로 폴백 경로는 쓰지 않는다.

각각 단독 실행:

```bash
node scripts/spike/1-stream-input.mjs
node scripts/spike/2-plugin-skills.mjs
node scripts/spike/3-app-mcp.mjs
```

## 1. 프로세스 하나로 여러 턴 (`--input-format stream-json`) — PASS

`claude -p --input-format stream-json --output-format stream-json --session-id <uuid>` 로
띄운 프로세스에 stdin 으로 user 메시지를 두 번 밀어 넣었다.

- 두 턴 모두 `result subtype=success`
- 2번째 턴이 1번째 턴에서 준 숫자(`8347`)를 기억 → **맥락 공유 확인**
- `session_id` 가 우리가 발급한 uuid 로 고정 → 세션 식별을 앱이 통제
- stdin 을 닫으면 exit code 0 으로 깔끔히 종료

→ `runner.js` 는 사람 한 명당 프로세스 하나를 살려두고 stdin 으로 턴을 보낸다.
턴마다 `--resume` 로 재실행하는 폴백은 불필요.

stdin 메시지 형식:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null,"session_id":"<uuid>"}
```

## 2. `--plugin-dir` 로 스킬 세션 단위 스코프 — PASS

fixture 플러그인(`fixtures/persona-test`)에 암호를 답하는 스킬을 하나 넣고 두 번 돌렸다.
빈 임시 폴더를 cwd 로 써야 한다 — 안 그러면 베이스라인 세션이 SKILL.md 를 그냥 파일로 읽어버려
테스트가 무효가 된다 (1차 실행에서 실제로 그랬음).

| | 스킬 인지 | 답변 |
| --- | --- | --- |
| `--plugin-dir` 없음 | 없음 | "무슨 코드인지 모르겠다" |
| `--plugin-dir` 있음 | `init.skills` 에 `crew-persona-test:crew-handshake` | 암호 정답 |

`init.plugins` 에 로드된 플러그인의 이름·경로·버전이 그대로 들어온다 → UI 에서 "이 사람에게
어떤 스킬 팩이 붙었는지" 를 추측이 아니라 사실로 표시할 수 있다.

→ `personas/<type>/` 을 플러그인 디렉터리로 만든다. 파일 복사 없음, 편집하면 다음 스폰부터 반영.

## 3. 의존성 0 로컬 HTTP MCP 서버 — PASS

`node:http` 만으로 스트리머블 HTTP MCP 서버를 세우고 `--mcp-config` 로 붙였다.

- `init.mcp_servers` → `[{"name":"office","status":"connected"}]`
- 세션이 `mcp__office__set_status` 를 실제로 호출
- **URL 에 박은 세션 토큰으로 어느 세션의 호출인지 식별됨** — 앱이 사람별로 상태를 귀속시킬 수 있다

구현에 필요한 JSON-RPC 메서드는 `initialize`, `tools/list`, `tools/call` 3개뿐이고,
`id` 없는 notification 은 202 로 응답하면 된다. 응답은 SSE 없이 `application/json` 단발로 충분.

→ `mcpServer.js` 를 `server.js` 안에 `/mcp/<token>` 라우트로 얹는다.

## 4. 헤드리스에서 승인을 중계하는 훅은 `PreToolUse` 다 — `PermissionRequest` 가 아니다

claude-office 는 `PermissionRequest` 훅의 HTTP 응답을 붙잡아 승인 UI 를 만들었다. 같은 방식을
그대로 옮겼더니 카드가 한 번도 안 떴다. 훅 수신기를 세워 놓고 4가지 permission-mode 로 각각
`-p` 세션을 돌려 확인한 결과:

| permission-mode | PermissionRequest 훅 호출 | 파일 생성 |
| --- | --- | --- |
| default | **0회** | 안 됨 |
| manual | **0회** | 안 됨 |
| dontAsk | **0회** | 안 됨 |
| acceptEdits | 0회 | 됨 (묻지 않고 통과) |

`PermissionRequest` 는 **대화형 세션 전용**이다. claude-office 는 남이 띄운 대화형 세션을
관찰하니까 됐던 것이고, 우리처럼 `-p` 로 직접 띄운 세션에서는 영영 안 불린다.

반면 `PreToolUse` 는 헤드리스에서 정상 동작한다:

- 모든 도구 호출마다 불린다 (Write, PowerShell 둘 다 확인)
- `permissionDecision: "allow"` → 실제로 실행됨 (파일 생성됨)
- `permissionDecision: "deny"` → 차단되고 사유가 모델에게 전달됨
- **응답을 지연시킬 수 있다** (3초 붙잡아 확인) → 이게 승인 대기의 정체

→ `crew.js` 의 `sessionSettings()` 는 `PreToolUse` 훅을 심고, `approvals.js` 는
`{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision, permissionDecisionReason}}`
를 응답 바디로 돌려준다.

부수 효과: 훅이 **모든** 도구에 걸리므로 무엇을 물어볼지는 훅 안에서 가려야 한다. 지금은
기본이 허용이고 `src/risk.js` 가 위험하다고 본 것만 카드가 된다 — 되돌리기 어려운 변경,
자격·개인정보 파일, 환경변수 노출. 안 그러면 파일 하나 읽을 때마다 클릭을 요구해서 쓸 수 없다.

## 5. 돌던 턴을 중간에 끊을 수 있다 (`control_request` / `interrupt`) — PASS

`node scripts/spike/4-interrupt.mjs`

사무실에는 "보내기" 밖에 없어서 한 번 시킨 일은 끝날 때까지 기다리는 수밖에 없었다.
보통의 세션에서 Esc 로 하는 그 일이 헤드리스에서도 되는지가 질문이었고, 된다:

- stdin 에 `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`
- CLI 가 `control_response` 로 `subtype: "success"` 를 돌려준다
- 돌던 턴은 `result` 의 `subtype: "error_during_execution"` 으로 끝난다
  (→ **중단도 `is_error: true` 다.** 우리가 끊은 것과 진짜 실패를 앱이 따로 표시해야
  사람이 누른 버튼이 사고처럼 보이지 않는다)
- **프로세스는 살아 있고, 다음 말이 그대로 통한다** — 대화를 잃지 않는다

한 가지 주의: 끊긴 턴에서 하던 말은 **문맥에 남지 않는다**. 끊고 나서 "방금 어디까지
셌냐" 고 물었더니 "아직 시작하지 않았습니다" 라고 답했다. 그래서 이어서 시킬 때는
무엇을 하다 말았는지 사람이 다시 일러 줘야 한다.

→ `runner.js` 의 `interrupt()`, `crew.js` 의 `stop()`, 화면의 "중단" 버튼.
대답이 없을 때를 대비해 8초 시한을 걸고, 넘기면 프로세스를 갈아 끼운다.

## 공통으로 확인된 것

- **Windows**: `spawn(bin, args)` 가 안 먹어서 argv 를 한 문자열로 합쳐 `shell: true` 로 띄운다.
  종료는 `taskkill /PID <pid> /T /F` (셸을 한 번 거치므로 손자 프로세스가 남는다).
- **과금 격리**: 자식 env 에서 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` 를 지운 상태로 전부 정상 동작 →
  구독 로그인만으로 돌아간다는 것이 실증됨.
- `--setting-sources ''` 로 이 머신의 user/project 설정을 배제해도 내장 스킬은 남는다.
  persona 스킬만 남기려면 `--plugin-dir` 로 더하는 방식이 맞다.
