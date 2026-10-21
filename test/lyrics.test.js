/**
 * 歌词解析与翻译对齐的单元测试
 * 运行：node --test test/lyrics.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, matchTranslation } from '../public/js/lyrics.js';

test('parseLrc 解析基本 LRC', () => {
  const lrc = '[00:01.00]第一行\n[00:05.50]第二行\n[01:00.00]第三行';
  const lines = parseLrc(lrc);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { time: 1, text: '第一行' });
  assert.deepEqual(lines[1], { time: 5.5, text: '第二行' });
  assert.deepEqual(lines[2], { time: 60, text: '第三行' });
});

test('parseLrc 支持一行多个时间戳', () => {
  const lines = parseLrc('[00:01.00][00:10.00]副歌');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.time), [1, 10]);
  assert.ok(lines.every((l) => l.text === '副歌'));
});

test('parseLrc 忽略元数据行与空行', () => {
  const lines = parseLrc('[ar:歌手]\n[ti:标题]\n\n[00:01.00]正文');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '正文');
});

test('parseLrc 兼容空输入', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc(undefined), []);
});

test('matchTranslation 精确时间戳匹配', () => {
  const lines = parseLrc('[00:10.00]Hello\n[00:20.00]World');
  const t = parseLrc('[00:10.00]你好\n[00:20.00]世界');
  const map = matchTranslation(lines, t);
  assert.equal(map.get(10), '你好');
  assert.equal(map.get(20), '世界');
});

test('matchTranslation 容忍 50ms 的时间戳偏差', () => {
  // 实测上游原文与翻译可能相差 50ms
  const lines = parseLrc('[00:01.000]作词 : A\n[00:02.000]作曲 : B');
  const t = parseLrc('[00:01.050]作詞 : A\n[00:02.050]作曲 : B');
  const map = matchTranslation(lines, t);
  assert.equal(map.get(1), '作詞 : A', '应按容差匹配到 1.000');
  assert.equal(map.get(2), '作曲 : B', '应按容差匹配到 2.000');
});

test('matchTranslation 超出容差时不匹配', () => {
  const lines = parseLrc('[00:01.000]A');
  const t = parseLrc('[00:05.000]B');
  const map = matchTranslation(lines, t);
  assert.equal(map.size, 0, '5 秒偏差不应匹配');
});

test('matchTranslation 不会把一个翻译行匹配给多个原文行', () => {
  const lines = parseLrc('[00:01.000]A\n[00:01.100]B');
  const t = parseLrc('[00:01.000]X\n[00:01.000]Y');
  const map = matchTranslation(lines, t);
  // 两个翻译行时间戳相同，只能精确匹配第一个，另一个因原文行已占用而不匹配
  assert.equal(map.size, 1);
});

test('matchTranslation 空输入安全', () => {
  assert.equal(matchTranslation([], []).size, 0);
  assert.equal(matchTranslation(parseLrc('[00:01.00]A'), []).size, 0);
  assert.equal(matchTranslation([], parseLrc('[00:01.00]B')).size, 0);
});
