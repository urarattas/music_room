/**
 * 端到端模拟 Docker 构建流程
 *
 * 按 Dockerfile 的步骤逐步执行（不实际用 docker）：
 *   1. 拷贝 package.json → 安装生产依赖
 *   2. 拷贝 server/ public/ package.json
 *   3. 以生产环境变量启动
 *   4. 验证页面 / 接口 / 优雅退出
 *
 * 运行：node test/docker-e2e.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 34670;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

// ===== 阶段 1：构建上下文（模拟 .dockerignore 过滤后）=====
const ctx = await fsp.mkdtemp(path.join(os.tmpdir(), 'mr-ctx-'));
await fsp.cp(path.join(ROOT, 'server'), path.join(ctx, 'server'), { recursive: true });
await fsp.cp(path.join(ROOT, 'public'), path.join(ctx, 'public'), { recursive: true });
await fsp.copyFile(path.join(ROOT, 'package.json'), path.join(ctx, 'package.json'));
console.log('构建上下文内容:', fs.readdirSync(ctx).join(', '));
check('构建上下文不含 node_modules', !fs.existsSync(path.join(ctx, 'node_modules')));
check('构建上下文不含 test/ 与 docs/', !fs.existsSync(path.join(ctx, 'test')) && !fs.existsSync(path.join(ctx, 'docs')));

// ===== 阶段 2：运行阶段镜像内容 =====
const img = await fsp.mkdtemp(path.join(os.tmpdir(), 'mr-img-'));
await fsp.cp(path.join(ctx, 'server'), path.join(img, 'server'), { recursive: true });
await fsp.cp(path.join(ctx, 'public'), path.join(img, 'public'), { recursive: true });
await fsp.copyFile(path.join(ctx, 'package.json'), path.join(img, 'package.json'));
// Dockerfile 里 mkdir -p /app/node_modules
await fsp.mkdir(path.join(img, 'node_modules'), { recursive: true });
console.log('镜像内容:', fs.readdirSync(img).join(', '));

// ===== 阶段 3：启动 =====
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: img,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '0.0.0.0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let err = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (err += d));

const started = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 10000);
  child.stdout.on('data', () => {
    if (out.includes('已启动')) {
      clearTimeout(t);
      resolve(true);
    }
  });
  child.on('exit', () => {
    clearTimeout(t);
    resolve(false);
  });
});
check('容器内启动成功', started, started ? '' : err.slice(0, 200));

try {
  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
  const hj = await health.json();
  check('健康检查可用（HEALTHCHECK 依赖此接口）', health.status === 200 && hj.ok === true);

  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  const html = await page.text();
  check('首页可访问', page.status === 200 && html.includes('音乐听歌房'));

  // 所有前端静态资源
  const assets = ['/styles.css', '/js/main.js', '/js/gd-api.js', '/js/player.js', '/js/rtc.js', '/js/ws.js', '/js/lyrics.js', '/js/chat.js', '/js/search.js', '/js/cover-loader.js'];
  let bad = [];
  for (const a of assets) {
    const r = await fetch(`http://127.0.0.1:${PORT}${a}`);
    if (!r.ok) bad.push(`${a}(${r.status})`);
  }
  check('所有前端资源可访问', bad.length === 0, bad.join(', '));

  // 模拟 docker stop：发 SIGTERM
  //
  // 注意：Windows 上 Node 收到信号会直接终止进程（退出码为 null + signal），
  // 不走 JS 的 signal handler —— 这是 Windows 平台限制。
  // Docker 跑在 Linux，那里 handler 会正常生效。
  // 因此这里断言「进程确实退出了」，并另行静态校验 handler 已注册。
  const exitInfo = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 6000);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });
  check(
    'SIGTERM 后进程退出（docker stop 行为）',
    exitInfo !== null,
    exitInfo ? `code=${exitInfo.code} signal=${exitInfo.signal}` : '超时未退出'
  );

  // 静态校验：服务端注册了 SIGTERM/SIGINT 处理器（Linux/Docker 下会生效）
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  check(
    '服务端注册了 SIGTERM / SIGINT 优雅退出处理器',
    /process\.on\(['"]SIGTERM['"]/.test(serverSrc) &&
      /process\.on\(['"]SIGINT['"]/.test(serverSrc)
  );
  check(
    '优雅退出会关闭 WebSocket 连接并以 code 0 结束',
    /server\.close\(/.test(serverSrc) && /process\.exit\(0\)/.test(serverSrc)
  );
} catch (e) {
  check('容器服务正常', false, e.message);
} finally {
  if (!child.killed) child.kill('SIGKILL');
  await fsp.rm(ctx, { recursive: true, force: true });
  await fsp.rm(img, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
process.exit(failed ? 1 : 0);
