/**
 * 复现 docker/metadata-action 的标签解析逻辑
 *
 * 背景：metadata-action 的 tags 解析器会先把整行按逗号切分，
 * 再按 `=` 切分。它**不会**剥离行尾的 `#` 注释 ——
 * 所以 `type=ref,event=branch  # 说明` 会让 event 的值变成
 * `branch  # 说明`，校验失败并报
 * `Invalid event for type=ref,event=branch`。
 *
 * 这里复刻该解析逻辑，用来校验工作流里的 tags 写法是否安全。
 *
 * 运行：node --test test/metadata-action.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows', 'docker-publish.yml');

/** 与 metadata-action 源码一致的枚举 */
const RefEvent = { Branch: 'branch', Tag: 'tag', PR: 'pr' };
const Type = {
  Schedule: 'schedule',
  Semver: 'semver',
  Pep440: 'pep440',
  Match: 'match',
  Edge: 'edge',
  Ref: 'ref',
  Raw: 'raw',
  Sha: 'sha',
};

/** 复刻 metadata-action 的 tag 解析（src/tag.ts） */
function parseTag(s) {
  const tag = { type: undefined, attrs: {} };
  const fields = s.split(',');
  for (const field of fields) {
    const parts = field
      .toString()
      .split(/(?<=^[^=]+?)=/)
      .map((item) => item.trim());
    if (parts.length === 1) {
      tag.attrs['value'] = parts[0];
    } else {
      const key = parts[0].toLowerCase();
      const value = parts[1];
      if (key === 'type') {
        if (!Object.values(Type).includes(value)) {
          throw new Error(`Unknown tag type attribute: ${value}`);
        }
        tag.type = value;
      } else {
        tag.attrs[key] = value;
      }
    }
  }
  if (tag.type === undefined) tag.type = Type.Raw;

  // 校验部分
  if (tag.type === Type.Ref) {
    if (!('event' in tag.attrs)) throw new Error(`Missing event attribute for ${s}`);
    if (!Object.values(RefEvent).includes(tag.attrs['event'])) {
      throw new Error(`Invalid event for ${s}`);
    }
  }
  if (tag.type === Type.Semver || tag.type === Type.Pep440) {
    if (!('pattern' in tag.attrs)) throw new Error(`Missing pattern attribute for ${s}`);
  }
  return tag;
}

test('复刻的解析器能识别无注释的合法标签', () => {
  const tag = parseTag('type=ref,event=branch');
  assert.equal(tag.type, 'ref');
  assert.equal(tag.attrs.event, 'branch');
});

test('复刻的解析器确实会因行尾注释而报错（证明这个坑真实存在）', () => {
  assert.throws(
    () => parseTag('type=ref,event=branch            # master -> master'),
    /Invalid event for/
  );
});

test('工作流的 tags 不含行尾注释', () => {
  const doc = YAML.parse(fs.readFileSync(WF, 'utf8'));
  const job = Object.values(doc.jobs)[0];
  const meta = job.steps.find((s) => (s.uses || '').startsWith('docker/metadata-action@'));
  assert.ok(meta, '应有 metadata-action 步骤');

  const tags = String(meta.with.tags)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);

  for (const t of tags) {
    assert.ok(
      !t.includes('#'),
      `标签 "${t}" 含 # 字符。metadata-action 不会剥离行尾注释，` +
        `注释会让属性值带上注释内容而报 Invalid event。请把说明移到独立注释行。`
    );
  }
});

test('工作流的所有 tags 都能被 metadata-action 正确解析', () => {
  const doc = YAML.parse(fs.readFileSync(WF, 'utf8'));
  const job = Object.values(doc.jobs)[0];
  const meta = job.steps.find((s) => (s.uses || '').startsWith('docker/metadata-action@'));

  const tags = String(meta.with.tags)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);

  assert.ok(tags.length > 0, '应至少有一个标签');
  for (const t of tags) {
    const tag = parseTag(t); // 解析失败会直接抛错
    assert.ok(tag.type, `${t} 应解析出 type`);
  }
});

test('工作流包含预期的标签类型', () => {
  const doc = YAML.parse(fs.readFileSync(WF, 'utf8'));
  const job = Object.values(doc.jobs)[0];
  const meta = job.steps.find((s) => (s.uses || '').startsWith('docker/metadata-action@'));
  const tags = String(meta.with.tags)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);

  const parsed = tags.map(parseTag);
  const types = parsed.map((t) => t.type);

  assert.ok(types.includes('ref'), '应有 ref 类型（分支/标签/PR）');
  assert.ok(types.includes('semver'), '应有 semver 类型（语义化版本）');
  assert.ok(types.includes('raw'), '应有 raw 类型（latest）');
  assert.ok(types.includes('sha'), '应有 sha 类型（提交追溯）');

  // branch / tag / pr 三种 ref 事件都要有
  const refEvents = parsed
    .filter((t) => t.type === 'ref')
    .map((t) => t.attrs.event);
  for (const e of ['branch', 'tag', 'pr']) {
    assert.ok(refEvents.includes(e), `应有 ref,event=${e}`);
  }
});

test('labels 块不受行尾注释影响（它不做 = 切分）', () => {
  const doc = YAML.parse(fs.readFileSync(WF, 'utf8'));
  const job = Object.values(doc.jobs)[0];
  const meta = job.steps.find((s) => (s.uses || '').startsWith('docker/metadata-action@'));
  const labels = String(meta.with.labels)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);

  assert.ok(labels.length > 0, '应有 OCI 标签');
  for (const l of labels) {
    assert.match(l, /^[a-z0-9.]+=/, `标签 "${l}" 应为 key=value 形式`);
  }
});
