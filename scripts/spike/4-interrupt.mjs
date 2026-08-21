/**
 * Spike 4 — 돌고 있는 턴을 중간에 끊을 수 있는가.
 *
 * 사무실에는 "보내기" 밖에 없어서, 한 번 시킨 일은 끝날 때까지 지켜보는 수밖에
 * 없었다. 보통의 세션에서 Esc 로 하는 그 일을 헤드리스에서도 할 수 있는지가
 * 이 스파이크의 질문이다.
 *
 * 후보 둘:
 *   A. stdin 으로 control_request { subtype: "interrupt" } — 프로세스가 살아
 *      남으므로 대화도 그대로다. 되면 이쪽이 정답.
 *   B. 프로세스를 죽이고 --resume 으로 다시 붙기 — 언제나 되지만 붙는 데
 *      몇 초가 들고, 죽는 순간 돌던 도구는 어중간하게 끝난다.
 *
 * 실행: node scripts/spike/4-interrupt.mjs
 */
import { randomUUID } from 'node:crypto';
import { spawnClaude, killTree, lineJson, pass, fail } from './lib.mjs';

const sessionId = randomUUID();
const child = spawnClaude([
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--session-id', sessionId,
  '--model', 'haiku',
  '--permission-mode', 'bypassPermissions',
]);

const seen = [];
let interrupted = false;
let sawResult = false;
let controlResponse = null;

child.stdout.on('data', lineJson((ev) => {
  seen.push(ev.type);
  if (ev.type === 'control_response') {
    controlResponse = ev;
    console.log('  control_response:', JSON.stringify(ev).slice(0, 200));
  }
  if (ev.type === 'result') {
    sawResult = true;
    console.log(`  result: subtype=${ev.subtype} is_error=${ev.is_error}`);
    console.log(`  text: ${String(ev.result ?? '').slice(0, 120)}`);
  }
}));
child.stderr.on('data', (c) => {
  const s = c.toString('utf8').trim();
  if (s) console.log('  stderr:', s.slice(0, 200));
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

// 오래 걸릴 일을 시킨다 — 끊을 것이 있어야 끊는지 알 수 있다.
console.log('1) 오래 걸리는 일을 시킨다');
send({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'text',
      text: '1 부터 40 까지 세면서, 각 숫자마다 그 숫자에 대한 짧은 사실을 한 문장씩 써라. 천천히, 하나도 빼먹지 말고.',
    }],
  },
  parent_tool_use_id: null,
  session_id: sessionId,
});

await new Promise((r) => { setTimeout(r, 6000); });

console.log('2) control_request interrupt 를 보낸다');
const requestId = `req_${randomUUID()}`;
send({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
interrupted = true;

await new Promise((r) => { setTimeout(r, 12000); });

/**
 * 끊는 것만으로는 반쪽이다. 끊고 나서 **말이 계속 통해야** 버튼으로 쓸 수 있다 —
 * 안 통하면 그건 끊기가 아니라 죽이기다.
 */
console.log('3) 끊은 뒤에 말이 통하는가');
let repliedAfter = '';
child.stdout.on('data', lineJson((ev) => {
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) if (b.type === 'text') repliedAfter += b.text;
  }
}));
send({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '방금 어디까지 셌는지 숫자 하나만 말해라.' }] },
  parent_tool_use_id: null,
  session_id: sessionId,
});
await new Promise((r) => { setTimeout(r, 25000); });
console.log('  끊은 뒤 답:', repliedAfter.slice(0, 160) || '(없음)');

console.log('\n본 이벤트 종류:', [...new Set(seen)].join(', '));
console.log('프로세스 살아 있나:', child.exitCode === null);

if (controlResponse && child.exitCode === null && repliedAfter.trim()) {
  pass('interrupt 로 끊고, 같은 프로세스에서 대화가 그대로 이어진다');
} else if (controlResponse && child.exitCode === null) {
  fail('끊기는 되는데 그 뒤 말이 안 통한다 — 끊고 나서 되살리는 절차가 따로 필요하다');
} else if (sawResult && interrupted) {
  fail('턴은 끝났지만 control_response 가 없다 — 프로토콜을 다시 봐야 한다');
} else {
  fail('interrupt 에 아무 반응이 없다 — B안(죽이고 --resume)으로 가야 한다');
}

killTree(child);
setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
