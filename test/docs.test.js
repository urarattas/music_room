/**
 * 校验 Markdown 文档结构（代码块配对、标题层级、链接指向的文件存在）
 * 运行：node --test test/docs.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const mdFiles = ['README.md', 'docs/protocol.md', 'docs/contracts.md', 'docs/docker.md'];

for (const rel of mdFiles) {
  test(`${rel} 代码块成对闭合`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const fences = text.match(/^```/gm) || [];
    assert.equal(fences.length % 2, 0, `代码块数量为 ${fences.length}，应为偶数`);
  });

  test(`${rel} 内部链接指向的文件存在`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const links = [...text.matchAll(/\[[^\]]*\]\(([^)#][^)]*)\)/g)].map((m) => m[1]);
    for (const link of links) {
      if (/^https?:/.test(link)) continue; // 外链跳过
      // 去掉 #锚点，只校验文件路径
      const filePart = link.split('#')[0];
      if (!filePart) continue; // 纯锚点链接
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), filePart);
      assert.ok(
        fs.existsSync(target),
        `${rel} 中的链接 "${link}" 指向的文件不存在`
      );
    }
  });
}

test('README 提到所有三种启动方式', () => {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(text, /start\.bat/, '应提到 Windows 脚本');
  assert.match(text, /start\.sh/, '应提到 Linux/macOS 脚本');
  assert.match(text, /docker compose/, '应提到 Docker');
});

test('带锚点的链接能对应到真实标题', () => {
  // GitHub 锚点规则：标题转小写，空格转连字符，保留中文
  const toAnchor = (heading) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
      .replace(/\s+/g, '-');

  for (const rel of mdFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 抓取形如 [文字](路径#锚点) 的链接
    const links = [...text.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)].map((m) => m[1]);
    for (const link of links) {
      if (!link.includes('#')) continue;
      const [filePart, anchor] = link.split('#');
      if (!filePart || !anchor) continue;
      const target = path.resolve(path.dirname(path.join(ROOT, rel)), filePart);
      if (!fs.existsSync(target)) continue; // 文件不存在由另一个测试负责
      const targetText = fs.readFileSync(target, 'utf8');
      const targetHeadings = [...targetText.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => toAnchor(m[1]));
      assert.ok(
        targetHeadings.includes(anchor),
        `${rel} 指向 ${filePart}#${anchor}，但该文件里没有对应标题`
      );
    }
  }
});

test('README 说明开麦需要 HTTPS', () => {
  const text = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(text, /开麦.*HTTPS|HTTPS.*开麦/, '应提示开麦需要 HTTPS');
});
