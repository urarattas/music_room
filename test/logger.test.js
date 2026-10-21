/**
 * 日志模块测试：分级输出、按天分文件、轮转、过期清理
 * 运行：node --test test/logger.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger, LEVELS, dateStamp } from '../server/logger.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mr-log-'));
}

test('默认级别为 info，debug 不写入、info 及以上写入', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, level: 'info', console: false });
  log.debug('这条不该出现');
  log.info('这条应该出现');
  log.warn('警告也要');
  log.error('错误也要');

  const file = log.currentFile();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('这条不该出现'), 'debug 级别不应写入');
  assert.ok(text.includes('这条应该出现'));
  assert.ok(text.includes('警告也要'));
  assert.ok(text.includes('错误也要'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('设置 debug 级别后 debug 也会写入', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, level: 'debug', console: false });
  log.debug('调试信息');
  const text = fs.readFileSync(log.currentFile(), 'utf8');
  assert.ok(text.includes('调试信息'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('日志按天分文件，文件名带日期', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false });
  log.info('今天的日志');
  const file = log.currentFile();
  assert.match(path.basename(file), /^server-\d{4}-\d{2}-\d{2}\.log$/);
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('每行包含时间、级别、内容', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false });
  log.info('测试内容', { a: 1 });
  const line = fs.readFileSync(log.currentFile(), 'utf8').trim();
  assert.match(line, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]/, '应有时间戳');
  assert.match(line, /\[INFO\s*\]/, '应有级别');
  assert.ok(line.includes('测试内容'));
  assert.ok(line.includes('{"a":1}'), '应有附加信息');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Error 对象会记录堆栈', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false });
  log.error('出错了', new Error('boom'));
  const text = fs.readFileSync(log.currentFile(), 'utf8');
  assert.ok(text.includes('boom'));
  assert.ok(text.includes('Error: boom'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('超过 maxSize 后自动轮转', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxSize: 1024 });
  // 写足够多的内容触发多次轮转
  for (let i = 0; i < 100; i++) {
    log.info(`第 ${i} 行日志，内容较长一些用来快速占满空间`);
  }

  const base = log.currentFile();
  assert.ok(fs.existsSync(base), '当前文件应存在');
  assert.ok(fs.existsSync(`${base}.1`), '应生成 .1 轮转文件');

  // 当前文件不应超过上限太多
  const size = fs.statSync(base).size;
  assert.ok(size <= 1024 * 2, `当前文件应接近上限，实际 ${size}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('轮转文件数量不超过 maxFiles', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxSize: 512, maxFiles: 3 });
  for (let i = 0; i < 200; i++) {
    log.info(`第 ${i} 行，内容足够长以便触发多次轮转操作`);
  }

  const base = log.currentFile();
  const rotated = fs.readdirSync(dir).filter((n) => /^\S+\.log\.\d+$/.test(n));
  assert.ok(rotated.length <= 3, `轮转文件应不超过 3 个，实际 ${rotated.length}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理会删除超过 maxDays 的旧日志', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxDays: 7 });

  // 造一个 30 天前的旧文件
  const old = path.join(dir, 'server-2020-01-01.log');
  fs.writeFileSync(old, '很老的日志\n');
  // 一个今天的文件
  fs.writeFileSync(log.currentFile(), '今天的日志\n');

  const removed = log.cleanup();
  assert.ok(removed >= 1, '应删除至少一个过期文件');
  assert.ok(!fs.existsSync(old), '过期文件应被删除');
  assert.ok(fs.existsSync(log.currentFile()), '今天的文件应保留');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理会删除过期的轮转文件', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxDays: 7 });

  const old = path.join(dir, 'server-2020-01-01.log.1');
  fs.writeFileSync(old, '旧的轮转文件\n');
  // 把修改时间改到很久以前
  const oldTime = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(old, oldTime, oldTime);

  log.cleanup();
  assert.ok(!fs.existsSync(old), '过期的轮转文件应被删除');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理不会误删日志目录外的文件', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxDays: 7 });

  const other = path.join(dir, 'important.txt');
  fs.writeFileSync(other, '不要删我');
  const otherLog = path.join(dir, 'other-service.log');
  fs.writeFileSync(otherLog, '别的服务的日志');

  log.cleanup();

  assert.ok(fs.existsSync(other), '非日志文件不应被删除');
  assert.ok(fs.existsSync(otherLog), '别的服务的日志不应被删除');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('stats 返回日志概况', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false });
  log.info('一些内容');
  const s = log.stats();
  assert.equal(s.dir, dir);
  assert.ok(s.files >= 1);
  assert.ok(s.bytes > 0);
  assert.equal(s.level, 'info');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('日志目录不存在时会自动创建', () => {
  const base = tmpDir();
  const nested = path.join(base, 'a', 'b', 'c');
  const log = new Logger({ dir: nested, console: false });
  log.info('测试');
  assert.ok(fs.existsSync(nested));
  assert.ok(fs.existsSync(log.currentFile()));
  fs.rmSync(base, { recursive: true, force: true });
});

test('无法创建日志目录时不影响服务（降级为仅控制台）', () => {
  const base = tmpDir();
  // 用一个文件占据路径，让 mkdir 失败
  const blocked = path.join(base, 'blocked');
  fs.writeFileSync(blocked, 'x');

  const log = new Logger({ dir: blocked, console: false });
  // 不应抛出异常
  log.info('这条写不进去');
  log.error('这条也写不进去');
  assert.ok(log._fileError, '应记录文件错误');
  fs.rmSync(base, { recursive: true, force: true });
});

test('dateStamp 返回本地时区日期', () => {
  const d = new Date(2026, 0, 5);
  assert.equal(dateStamp(d), '2026-01-05');
});

test('LEVELS 覆盖四个级别且数值递增', () => {
  assert.ok(LEVELS.debug < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.error);
});

test('清理按文件名日期删除过期的主日志', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxDays: 7 });

  // 主日志按文件名里的日期判断过期
  const old = path.join(dir, 'server-2020-01-01.log');
  fs.writeFileSync(old, '很老\n');
  const recent = path.join(dir, 'server-2026-10-21.log');
  fs.writeFileSync(recent, '今天\n');

  const removed = log.cleanup();
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old), '过期主日志应被删除');
  assert.ok(fs.existsSync(recent), '未过期的主日志应保留');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('清理按修改时间删除过期的轮转文件', () => {
  const dir = tmpDir();
  const log = new Logger({ dir, console: false, maxDays: 7 });

  const old = path.join(dir, 'server-2026-10-21.log.1');
  fs.writeFileSync(old, '旧的轮转\n');
  const oldTime = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  fs.utimesSync(old, oldTime, oldTime);

  const removed = log.cleanup();
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(old));

  fs.rmSync(dir, { recursive: true, force: true });
});
