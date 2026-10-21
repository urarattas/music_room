/**
 * GitHub Actions 工作流配置校验
 * 运行：node --test test/workflow.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const readWf = (name) => YAML.parse(fs.readFileSync(path.join(WF_DIR, name), 'utf8'));

test('工作流目录存在且文件都是合法 YAML', () => {
  assert.ok(fs.existsSync(WF_DIR), '.github/workflows 应存在');
  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length >= 2, '至少应有 2 个工作流');
  for (const f of files) {
    const doc = YAML.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8'));
    assert.ok(doc, `${f} 应能解析`);
    assert.ok(doc.jobs && Object.keys(doc.jobs).length > 0, `${f} 应定义 jobs`);
  }
});

test('docker-publish.yml 具备推送镜像所需的关键配置', () => {
  const wf = readWf('docker-publish.yml');
  assert.ok(wf.name, '应有 name');
  assert.ok(wf.on, '应有触发条件 on');

  // 权限：需要 packages: write
  assert.equal(wf.permissions?.packages, 'write', '需要 packages: write 权限');

  const job = Object.values(wf.jobs)[0];
  const steps = job.steps;
  const uses = steps.map((s) => s.uses || '');

  // 必须有检出、登录、构建推送
  assert.ok(uses.some((u) => u.startsWith('actions/checkout@')), '需要 checkout');
  assert.ok(uses.some((u) => u.startsWith('docker/login-action@')), '需要 login-action');
  assert.ok(uses.some((u) => u.startsWith('docker/setup-buildx-action@')), '需要 setup-buildx');
  assert.ok(uses.some((u) => u.startsWith('docker/build-push-action@')), '需要 build-push-action');
  assert.ok(uses.some((u) => u.startsWith('docker/metadata-action@')), '需要 metadata-action');
});

test('登录 GHCR 使用内置 GITHUB_TOKEN，无需 secret', () => {
  const wf = readWf('docker-publish.yml');
  const job = Object.values(wf.jobs)[0];
  const login = job.steps.find((s) => (s.uses || '').startsWith('docker/login-action@'));
  assert.ok(login, '应有登录步骤');

  // registry 可以写死，也可以引用 env.REGISTRY（顶层已定义为 ghcr.io）
  const registry = login.with.registry;
  const registryIsGhcr =
    registry === 'ghcr.io' || registry === '${{ env.REGISTRY }}';
  assert.ok(registryIsGhcr, `registry 应为 ghcr.io，实际 ${registry}`);
  if (registry === '${{ env.REGISTRY }}') {
    assert.equal(wf.env?.REGISTRY, 'ghcr.io', 'env.REGISTRY 应为 ghcr.io');
  }

  assert.equal(login.with.password, '${{ secrets.GITHUB_TOKEN }}',
    '应使用内置 GITHUB_TOKEN，用户无需配置任何 secret');
});

test('拉取请求只构建不推送', () => {
  const wf = readWf('docker-publish.yml');
  const job = Object.values(wf.jobs)[0];
  const build = job.steps.find((s) => (s.uses || '').startsWith('docker/build-push-action@'));
  assert.ok(build, '应有构建步骤');
  assert.match(String(build.with.push), /github\.event_name\s*!=\s*'pull_request'/,
    'PR 时不应推送镜像');
});

test('构建多架构镜像', () => {
  const wf = readWf('docker-publish.yml');
  const job = Object.values(wf.jobs)[0];
  const build = job.steps.find((s) => (s.uses || '').startsWith('docker/build-push-action@'));
  const platforms = String(build.with.platforms);
  assert.match(platforms, /linux\/amd64/, '应包含 amd64');
  assert.match(platforms, /linux\/arm64/, '应包含 arm64');
});

test('Action 版本固定到具体版本号（不使用浮动的 major tag）', () => {
  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    for (const u of uses) {
      if (!u.includes('@')) continue;
      const ref = u.split('@')[1];
      assert.match(
        ref,
        /^v\d+\.\d+\.\d+$/,
        `${f} 中的 ${u} 应固定到具体版本（如 v7.0.1），避免浮动 tag 带来的不确定性`
      );
    }
  }
});

test('CI 工作流覆盖各测试套件', () => {
  const wf = readWf('ci.yml');
  const text = fs.readFileSync(path.join(WF_DIR, 'ci.yml'), 'utf8');
  const required = [
    'test/websocket.test.js',
    'test/lyrics.test.js',
    'test/docs.test.js',
    'test/docker.test.js',
    'test/dockerignore.test.js',
    'test/docker-npm.test.js',
    'test/shutdown.test.js',
    'test/integration.test.js',
  ];
  for (const r of required) {
    assert.ok(text.includes(r), `CI 应运行 ${r}`);
  }
  assert.ok(text.includes('docker build'), 'CI 应验证镜像能真正构建');
});

test('Dockerfile 含 OCI 标签以关联 GHCR 包', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /org\.opencontainers\.image\.source/,
    '应有 source 标签，否则 GHCR 包不会自动关联仓库');
  assert.match(dockerfile, /org\.opencontainers\.image\.title/);
  assert.match(dockerfile, /org\.opencontainers\.image\.licenses/);
  assert.match(
    dockerfile,
    /org\.opencontainers\.image\.source="https:\/\/github\.com\/urarattas\/music_room"/,
    'source 应指向本仓库'
  );
});

test('CI 与 Docker 构建是两个独立 workflow', () => {
  const ci = readWf('ci.yml');
  const docker = readWf('docker-publish.yml');
  assert.notEqual(ci.name, docker.name, '应是两个独立的工作流');
  // CI 不应有 packages: write，避免不必要的权限
  assert.notEqual(ci.permissions?.packages, 'write', 'CI 不需要 packages 权限');
});

test('pnpm 在需要它之前就已安装', () => {
  // setup-node 的 cache: pnpm 需要执行 `pnpm store path`，
  // 若此时 pnpm 未安装会报 "Unable to locate executable file: pnpm"。
  const wf = readWf('ci.yml');
  const job = Object.values(wf.jobs)[0];
  const steps = job.steps;

  const pnpmSetupIdx = steps.findIndex(
    (s) => (s.uses || '').startsWith('pnpm/action-setup@') || /corepack enable/.test(s.run || '')
  );
  assert.ok(pnpmSetupIdx >= 0, '应有安装 pnpm 的步骤');

  // setup-node 若启用了 pnpm 缓存，必须排在 pnpm 安装之后
  const setupNodeIdx = steps.findIndex((s) => (s.uses || '').startsWith('actions/setup-node@'));
  if (setupNodeIdx >= 0) {
    const setupNode = steps[setupNodeIdx];
    const cache = setupNode.with?.cache;
    if (cache === 'pnpm') {
      assert.ok(
        pnpmSetupIdx < setupNodeIdx,
        'setup-node 启用 cache: pnpm 时，pnpm 必须先安装'
      );
    }
  }

  // 所有用到 pnpm 命令的 run 步骤，都必须在 pnpm 安装之后
  const firstPnpmUse = steps.findIndex((s) => /\bpnpm\s+(install|run|exec)\b/.test(s.run || ''));
  if (firstPnpmUse >= 0) {
    assert.ok(
      pnpmSetupIdx < firstPnpmUse,
      `执行 pnpm 命令的步骤（第 ${firstPnpmUse + 1} 步）必须在安装 pnpm 之后`
    );
  }
});

test('pnpm 缓存由 pnpm/action-setup 提供，不依赖 setup-node', () => {
  const wf = readWf('ci.yml');
  const job = Object.values(wf.jobs)[0];
  const steps = job.steps;

  const pnpmSetup = steps.find((s) => (s.uses || '').startsWith('pnpm/action-setup@'));
  assert.ok(pnpmSetup, '应使用 pnpm/action-setup 安装 pnpm');
  // YAML 里 true 会被解析成布尔，GitHub Actions 两种都接受
  const cache = pnpmSetup.with?.cache;
  assert.ok(
    cache === true || cache === 'true',
    `应启用 pnpm 缓存，实际 ${JSON.stringify(cache)}`
  );
  assert.equal(pnpmSetup.with?.cache_dependency_path, 'pnpm-lock.yaml');

  // setup-node 不应再配 cache: pnpm（那正是报错的来源）
  const setupNode = steps.find((s) => (s.uses || '').startsWith('actions/setup-node@'));
  if (setupNode) {
    assert.notEqual(
      setupNode.with?.cache,
      'pnpm',
      'setup-node 不应配置 cache: pnpm，缓存交给 pnpm/action-setup'
    );
  }
});

test('package.json 声明了 packageManager 字段', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.packageManager, '应声明 packageManager 以统一 pnpm 版本');
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
});

test('CI 使用的 pnpm 版本与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const wf = readWf('ci.yml');
  const job = Object.values(wf.jobs)[0];
  const pnpmSetup = job.steps.find((s) => (s.uses || '').startsWith('pnpm/action-setup@'));
  const expected = pkg.packageManager.split('@')[1];
  assert.equal(
    pnpmSetup.with?.version,
    expected,
    'CI 安装的 pnpm 版本应与 package.json 的 packageManager 一致'
  );
});

test('CI 的单元测试步骤覆盖所有工作流相关测试', () => {
  const wf = readWf('ci.yml');
  const job = Object.values(wf.jobs)[0];
  const unitStep = job.steps.find((s) => s.name === '单元测试');
  assert.ok(unitStep, '应有单元测试步骤');
  const script = unitStep.run;
  for (const f of ['test/workflow.test.js', 'test/metadata-action.test.js']) {
    assert.ok(script.includes(f), `CI 的单元测试应运行 ${f}`);
  }
});

test('依赖上游的测试用例会跳过而非失败', () => {
  // 上游在 Cloudflare 后面，对 GitHub runner 这类数据中心 IP 经常返回 403。
  // 那些用例必须能跳过，保证 CI 退出码为 0。
  const src = fs.readFileSync(path.join(ROOT, 'test', 'integration.test.js'), 'utf8');

  // 必须有探测上游可用性的辅助函数
  assert.match(src, /isUpstreamAvailable/, '应探测上游可用性');
  assert.match(src, /skipIfUpstreamDown/, '应有跳过辅助函数');
  assert.match(src, /t\.skip\(/, '应使用 t.skip() 跳过');

  // 三项依赖上游的用例都要先检查
  const upstreamTests = [
    '上游 API 支持浏览器跨域直连',
    '每个客户端可独立从上游获取播放地址',
    '上游歌词接口返回原文与翻译',
  ];
  for (const name of upstreamTests) {
    const idx = src.indexOf(`'${name}'`);
    assert.ok(idx > 0, `应存在用例 ${name}`);
    // 该用例之后 200 字内应调用 skipIfUpstreamDown
    const nearby = src.slice(idx, idx + 200);
    assert.ok(
      nearby.includes('skipIfUpstreamDown'),
      `用例「${name}」应在开头调用 skipIfUpstreamDown`
    );
  }
});
