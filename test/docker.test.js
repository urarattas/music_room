/**
 * Docker 配置静态校验
 * 验证 Dockerfile / docker-compose.yml / .dockerignore 的正确性
 * 运行：node --test test/docker.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');

test('docker-compose.yml 是合法 YAML 且结构正确', () => {
  const doc = YAML.parse(compose);
  assert.ok(doc.services, '应有 services 段');
  const svc = doc.services['music-room'];
  assert.ok(svc, '应有 music-room 服务');
  assert.ok(svc.build?.dockerfile === 'Dockerfile', '应指定 Dockerfile');
  assert.ok(svc.ports?.length, '应配置端口映射');
  assert.ok(svc.environment?.HOST === '0.0.0.0', '容器内必须监听 0.0.0.0');
  assert.equal(svc.restart, 'unless-stopped');
  assert.ok(svc.healthcheck?.test, '应配置健康检查');
});

test('端口映射把容器 3000 暴露出来', () => {
  const doc = YAML.parse(compose);
  const mapping = doc.services['music-room'].ports[0];
  assert.match(mapping, /:3000$/, '右侧应为容器内端口 3000');
});

test('Dockerfile 使用多阶段构建', () => {
  const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+(\S+)/gim)];
  assert.ok(stages.length >= 2, '应至少有两个阶段');
  assert.ok(stages.some((s) => /deps/i.test(s[2])), '应有依赖安装阶段');
  assert.ok(stages.some((s) => /runtime/i.test(s[2])), '应有运行阶段');
});

test('Dockerfile 使用 Node 18+ 基础镜像', () => {
  const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  for (const f of froms) {
    const m = f.match(/^node:(\d+)/i);
    if (m) {
      assert.ok(Number(m[1]) >= 18, `基础镜像 node:${m[1]} 版本应 >= 18`);
    }
  }
});

test('Dockerfile 暴露 3000 端口并设置环境变量', () => {
  assert.match(dockerfile, /EXPOSE\s+3000/i);
  assert.match(dockerfile, /ENV\s+PORT=3000/i);
  assert.match(dockerfile, /ENV\s+HOST=0\.0\.0\.0/i);
});

test('Dockerfile 以非 root 用户运行', () => {
  assert.match(dockerfile, /^\s*USER\s+(?!root)\S+/im);
  // USER 必须出现在 CMD 之前
  assert.ok(
    dockerfile.indexOf('USER') < dockerfile.indexOf('CMD'),
    'USER 应在 CMD 之前'
  );
});

test('Dockerfile 配置了健康检查', () => {
  assert.match(dockerfile, /HEALTHCHECK/i);
  assert.match(dockerfile, /api\/health/);
});

test('Dockerfile 使用 tini 处理信号', () => {
  assert.match(dockerfile, /tini/i);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\/sbin\/tini"/);
});

test('Dockerfile 只拷贝运行所需文件', () => {
  assert.match(dockerfile, /COPY\s+server\s+\.\/server/);
  assert.match(dockerfile, /COPY\s+public\s+\.\/public/);
  // 不应把测试与文档拷进运行镜像
  assert.doesNotMatch(dockerfile, /COPY\s+test\b/);
  assert.doesNotMatch(dockerfile, /COPY\s+docs\b/);
});

test('.dockerignore 排除了 node_modules 与 .git', () => {
  const entries = dockerignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(entries.includes('node_modules'), '应排除 node_modules');
  assert.ok(entries.includes('.git'), '应排除 .git');
  assert.ok(entries.includes('.cache'), '应排除 .cache');
});

test('.dockerignore 不会误排除运行所需文件', () => {
  const entries = dockerignore
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const must in ['server', 'public', 'package.json']) {
    assert.ok(
      !entries.includes(must),
      `.dockerignore 不应排除 ${must}`
    );
  }
});
