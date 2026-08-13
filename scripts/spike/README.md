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

## 공통으로 확인된 것

- **Windows**: `spawn(bin, args)` 가 안 먹어서 argv 를 한 문자열로 합쳐 `shell: true` 로 띄운다.
  종료는 `taskkill /PID <pid> /T /F` (셸을 한 번 거치므로 손자 프로세스가 남는다).
- **과금 격리**: 자식 env 에서 `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CONFIG_DIR` 를 지운 상태로 전부 정상 동작 →
  구독 로그인만으로 돌아간다는 것이 실증됨.
- `--setting-sources ''` 로 이 머신의 user/project 설정을 배제해도 내장 스킬은 남는다.
  persona 스킬만 남기려면 `--plugin-dir` 로 더하는 방식이 맞다.
