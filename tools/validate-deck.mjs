#!/usr/bin/env node
/* 内置词库校验：node tools/validate-deck.mjs
 * 有问题以非 0 退出，便于 CI / 人工复核。 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECK = resolve(ROOT, 'data/deck.builtin.json');
const MIN_CARDS = 300;
const MAX_CARDS = 500;

const problems = [];
const fail = (m) => problems.push(m);

let deck;
try {
  deck = JSON.parse(readFileSync(DECK, 'utf8'));
} catch (err) {
  console.error('无法解析 ' + DECK + '：' + err.message);
  process.exit(1);
}

const cards = Array.isArray(deck.cards) ? deck.cards : null;
if (!cards) {
  console.error('deck.cards 不是数组');
  process.exit(1);
}

if (cards.length < MIN_CARDS || cards.length > MAX_CARDS) {
  fail('卡片数 ' + cards.length + ' 不在 ' + MIN_CARDS + '-' + MAX_CARDS + ' 之间');
}

const words = new Map();
const ids = new Set();
let withExample = 0;
let senseCount = 0;

cards.forEach((c, i) => {
  const where = '[' + i + '] ' + (c && c.word ? c.word : '(无 word)');
  if (!c || typeof c !== 'object') { fail(where + ' 不是对象'); return; }
  if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) fail(where + ' id 非法：' + c.id);
  if (ids.has(c.id)) fail(where + ' id 重复：' + c.id);
  ids.add(c.id);
  if (typeof c.word !== 'string' || !c.word.trim() || c.word.length > 8) fail(where + ' word 非法');
  if (words.has(c.word)) fail(where + ' word 重复（首次出现在 [' + words.get(c.word) + ']）');
  else words.set(c.word, i);
  if (!Array.isArray(c.senses) || !c.senses.length) { fail(where + ' 缺少 senses'); return; }
  let hasEx = false;
  c.senses.forEach((s, j) => {
    senseCount += 1;
    if (!s || typeof s.def !== 'string' || !s.def.trim()) fail(where + ' senses[' + j + '].def 为空');
    if (s && s.example) {
      if (!s.example.source) fail(where + ' senses[' + j + '].example 缺少出处');
      else { hasEx = true; }
    }
  });
  if (hasEx) withExample += 1;
});

const pct = Math.round((withExample / cards.length) * 100);
console.log('文件：' + DECK);
console.log('总条数：' + cards.length + '（要求 ' + MIN_CARDS + '-' + MAX_CARDS + '）');
console.log('义项总数：' + senseCount + '（平均 ' + (senseCount / cards.length).toFixed(2) + ' 个/条）');
console.log('带例句出处：' + withExample + ' 条（' + pct + '%）');
console.log('重复 word：' + (cards.length - words.size));
console.log('重复 id：' + (cards.length - ids.size));

if (problems.length) {
  console.error('\n发现 ' + problems.length + ' 个问题：');
  problems.slice(0, 40).forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
if (pct < 60) {
  console.error('\n带例句比例 ' + pct + '% 低于 60% 要求');
  process.exit(1);
}
console.log('\n校验通过。');
