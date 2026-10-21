/**
 * 模拟 .dockerignore 的匹配逻辑，验证构建上下文里该有的文件都在
 * 运行：node --test test/dockerignore.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const patterns = fs
  .readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** 模拟 Docker 的 ignore 匹配（路径模式，非正则） */
function isIgnored(relPath) {
  const p = relPath.replace(/\\/g, '/');
  const parts = p.split('/');
  for (const pat of patterns) {
    const negated = pat.startsWith('!');
    const target = negated ? pat.slice(1) : pat;
    if (p === target) return !negated;
    // 目录前缀匹配：node_modules 匹配 node_modules/xxx
    if (p.startsWith(target + '/')) return !negated;
    // 任意路径段匹配
    if (!target.includes('/') && parts.includes(target)) return !negated;
    // 通配符
    if (target.includes('*')) {
      const rx = new RegExp(
        '^' + target.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$'
      );
      if (rx.test(p) || parts.some((seg) => rx.test(seg))) return !negated;
    }
  }
  return false;
}

test('构建所需文件不会被忽略', () => {
  const required = [
    'server/index.js',
    'server/rooms.js',
    'server/ws.js',
    'public/index.html',
    'public/styles.css',
    'public/js/main.js',
    'public/js/gd-api.js',
    'public/js/player.js',
    'public/js/rtc.js',
    'public/js/ws.js',
    'public/js/lyrics.js',
    'public/js/chat.js',
    'public/js/search.js',
    'public/js/cover-loader.js',
    'package.json',
    'pnpm-lock.yaml',
  ];
  for (const f of required) {
    assert.ok(
      fs.existsSync(path.join(ROOT, f)),
      `${f} 应存在于项目中`
    );
    assert.ok(
      !isIgnored(f),
      `${f} 不应被 .dockerignore 排除（构建会失败）`
    );
  }
});

test('Dockerfile 本身不会被忽略', () => {
  assert.ok(!isIgnored('Dockerfile'), 'Dockerfile 不应被排除');
  assert.ok(!isIgnored('docker-compose.yml'), 'docker-compose.yml 不应被排除');
});

test('该被排除的文件确实被排除', () => {
  const excluded = [
    'node_modules/ws/index.js',
    '.git/config',
    'test/ui.test.js',
    'docs/protocol.md',
    '.cache/pics.json',
    '.env',
    'start.bat',
    'ui-a.png',
  ];
  for (const f of excluded) {
    assert.ok(isIgnored(f), `${f} 应被 .dockerignore 排除`);
  }
});

test('不会误排除同前缀的目录', () => {
  // server/ 与 serverless/ 是不同的东西
  assert.ok(!isIgnored('server/index.js'));
  assert.ok(!isIgnored('public/js/main.js'));
});
