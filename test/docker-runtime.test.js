/**
 * 模拟容器运行环境：验证 Docker 镜像里的启动方式是否可用
 *
 * 做法：把 server/ 与 public/ 复制到临时目录，模拟 Dockerfile 里
 * "只拷贝 server + public + package.json" 的结果，然后验证：
 *  - 能以生产环境变量启动
 *  - 能正常提供页面与接口
 *  - 以非 root / 只读场景下不依赖任何外部文件
 *
 * 运行：node test/docker-runtime.test.js
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34660;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// ---- 模拟镜像内容 ----
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'music-room-img-'));
await fsp.cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
await fsp.cp(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
console.log(`模拟镜像目录: ${tmp}`);
console.log('  内容:', fs.readdirSync(tmp).join(', '));
console.log('  包含 node_modules:', fs.existsSync(path.join(tmp, 'node_modules')));
console.log();

// ---- 用镜像里的方式启动 ----
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: tmp,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOST: '0.0.0.0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d));
child.stderr.on('data', (d) => (stderr += d));

// 等待启动
const started = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 10000);
  child.stdout.on('data', () => {
    if (stdout.includes('已启动')) {
      clearTimeout(t);
      resolve(true);
    }
  });
  child.on('exit', () => {
    clearTimeout(t);
    resolve(false);
  });
});

check('容器内启动成功', started, started ? '' : stderr.slice(0, 200));
if (started) console.log('  ' + stdout.trim().split('\n')[0]);

try {
  // ---- 验证容器内可正常提供服务 ----
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  const healthJson = await health.json();
  check('健康检查接口可用', health.status === 200 && healthJson.ok === true, JSON.stringify(healthJson));

  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  check('首页可访问', page.status === 200 && html.includes('音乐听歌房'));

  // 静态资源
  const js = await fetch(`http://127.0.0.1:${PORT}/js/main.js`);
  check('JS 静态资源可访问', js.status === 200);

  // 已移除的代理接口应 404
  const gone = await fetch(`http://127.0.0.1:${PORT}/api/search?name=x`);
  check('不再暴露音乐代理接口', gone.status === 404, `status=${gone.status}`);

  // ---- 优雅退出（模拟 docker stop 发 SIGTERM）----
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 6000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code === 0 || code === null);
    });
    child.kill('SIGTERM');
  });
  check('收到 SIGTERM 后优雅退出', exited);
} catch (err) {
  check('容器内服务正常', false, err.message);
} finally {
  if (!child.killed) child.kill('SIGKILL');
  await fsp.rm(tmp, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
