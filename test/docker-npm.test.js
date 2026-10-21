/**
 * 验证 Dockerfile 的依赖安装步骤在"零生产依赖"场景下不会失败
 *
 * 背景：package.json 的 dependencies 为空，npm install --omit=dev
 * 会创建一个空的 node_modules（可能连目录都不创建）。
 * Dockerfile 里 `COPY --from=deps /app/node_modules ./node_modules`
 * 如果源目录不存在会**直接构建失败** —— 这是个真实的坑。
 *
 * 运行：node --test test/docker-npm.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package.json 的生产依赖为空（服务端零运行时依赖）', () => {
  assert.deepEqual(pkg.dependencies, {}, '生产依赖应为空');
});

test('Dockerfile 从 deps 阶段拷贝 node_modules', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(
    dockerfile,
    /COPY\s+--from=deps\s+\/app\/node_modules\s+\.\/node_modules/,
    '应从 deps 阶段拷贝 node_modules'
  );
});

test('deps 阶段使用 npm 而非 pnpm（避免符号链接跨阶段问题）', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /npm install --omit=dev/);
  // deps 阶段不应再出现 pnpm install
  const depsStage = dockerfile.split(/FROM\s+node:22-alpine\s+AS\s+deps/i)[1]?.split(/FROM/i)[0] ?? '';
  assert.doesNotMatch(depsStage, /pnpm install/, 'deps 阶段不应使用 pnpm');
});

test('npm install --omit=dev 不含 devDependencies', () => {
  // 验证 package.json 里 devDependencies 确实不会被 --omit=dev 装上
  assert.ok(pkg.devDependencies['puppeteer-core'], 'puppeteer-core 应在 devDependencies');
  assert.ok(pkg.devDependencies['ws'], 'ws 应在 devDependencies');
  // 生产依赖为空 => 镜像里不会有这些大包
  assert.ok(!pkg.dependencies['puppeteer-core']);
});

test('模拟：npm install --omit=dev 在零生产依赖时的产物', () => {
  // 用一个只含空 dependencies 的临时包，验证 npm 的行为
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-probe-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'probe', version: '1.0.0', dependencies: {} }, null, 2)
    );
    const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: tmp,
      encoding: 'utf8',
      shell: true,
      timeout: 60000,
    });
    // npm 不在 PATH 时跳过实际执行（CI/精简环境常见）
    if (r.error || /not recognized|not found/i.test(r.stderr || '')) {
      console.log('  (跳过：当前环境无 npm，改为静态断言)');
    } else {
      assert.equal(r.status, 0, `npm install 应成功: ${r.stderr?.slice(0, 200)}`);
      const nm = path.join(tmp, 'node_modules');
      console.log(`  node_modules 存在: ${fs.existsSync(nm)}`);
    }

    // 无论 npm 是否创建了 node_modules，Dockerfile 的 COPY 都可能失败 ——
    // 因此必须保证目录存在。
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const hasCopy = /COPY\s+--from=deps\s+\/app\/node_modules/.test(dockerfile);
    const hasCreate =
      /mkdir\s+-p\s+\/app\/node_modules/.test(dockerfile) ||
      /mkdir\s+-p\s+node_modules/.test(dockerfile);
    if (hasCopy) {
      assert.ok(
        hasCreate,
        'node_modules 可能不存在，deps 阶段必须先 mkdir -p 保证 COPY 不失败'
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
