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
