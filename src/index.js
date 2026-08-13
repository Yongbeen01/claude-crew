import { execFile } from 'node:child_process';
import { config, baseUrl, ensureDirs, DATA_DIR } from './config.js';
import { createServer } from './server.js';
import { seedPersonas, listPersonas } from './personas.js';
import { startSystemPolling } from './system.js';
import { startUsagePolling } from './usage.js';
import { shutdownAll } from './crew.js';
import { logActivity } from './bus.js';

ensureDirs();
const seeded = seedPersonas();
const personas = listPersonas();

const server = createServer();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n포트 ${config.port} 가 이미 사용 중입니다.`);
    console.error('이미 실행 중이라면 브라우저에서 여세요:', baseUrl);
    console.error(`다른 포트로 쓰려면 ${DATA_DIR}\\config.json 의 "port" 를 바꾸세요.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  claude-crew');
  console.log(`  ${baseUrl}`);
  console.log(`  데이터   ${DATA_DIR}`);
  console.log(`  유형     ${personas.map((p) => p.label).join(', ') || '(없음)'}`);
  if (seeded.length) console.log(`  시드됨   ${seeded.join(', ')}`);
  console.log('');

  logActivity('system', 'claude-crew 시작');
  startSystemPolling();
  startUsagePolling();

  if (config.openBrowserOnStart) openBrowser(baseUrl);
});

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n종료 중… 세션을 정리합니다.');
  shutdownAll();
  server.close();
  // Give the taskkill in Runner.stop() a beat to land before the process goes.
  setTimeout(() => process.exit(0), 2500).unref?.();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
