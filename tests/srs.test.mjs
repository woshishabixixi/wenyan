import assert from 'node:assert/strict';
import { GRADES, schedule, newCardState, isDue, describeInterval, buildQueue, EF_MIN, GRADUATE_DAYS } from '../srs.js';

const DAY = 86400000;
const NOW = 1_700_000_000_000;
let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

ok('newCardState 默认值', () => {
  const s = newCardState(NOW);
  assert.equal(s.state, 'new');
  assert.equal(s.step, 0);
  assert.equal(s.ef, 2.5);
  assert.equal(s.due, NOW);
  assert.equal(s.reps, 0);
});

ok('新卡评「认识」→ learning 1 天', () => {
  const s = schedule(newCardState(NOW), GRADES.GOOD, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.step, 1);
  assert.equal(s.due, NOW + DAY);
  assert.equal(s.reps, 1);
});

ok('学习态二次「认识」→ 毕业 review 3 天', () => {
  const a = schedule(newCardState(NOW), GRADES.GOOD, NOW);
  const b = schedule(a, GRADES.GOOD, NOW);
  assert.equal(b.state, 'review');
  assert.equal(b.interval, GRADUATE_DAYS);
  assert.equal(b.due, NOW + GRADUATE_DAYS * DAY);
});

ok('review 评「认识」→ 间隔乘以易度因子', () => {
  const base = { ...newCardState(NOW), state: 'review', interval: 3, ef: 2.5, step: 2 };
  const s = schedule(base, GRADES.GOOD, NOW);
  assert.equal(s.ef, 2.6);
  assert.equal(s.interval, 7.8);
  assert.equal(s.due, NOW + 7.8 * DAY);
});

ok('review 评「忘记」→ lapses+1、ef-0.2、回 relearning 10 分钟', () => {
  const base = { ...newCardState(NOW), state: 'review', interval: 10, ef: 2.5, step: 2 };
  const s = schedule(base, GRADES.AGAIN, NOW);
  assert.equal(s.state, 'relearning');
  assert.equal(s.lapses, 1);
  assert.equal(s.ef, 2.3);
  assert.equal(s.interval, 1);
  assert.equal(s.due, NOW + 10 * 60000);
});

ok('review 评「模糊」→ 间隔×1.2、ef-0.15、仍在 review', () => {
  const base = { ...newCardState(NOW), state: 'review', interval: 10, ef: 2.5, step: 2 };
  const s = schedule(base, GRADES.HARD, NOW);
  assert.equal(s.state, 'review');
  assert.equal(s.interval, 12);
  assert.equal(s.ef, 2.35);
});

ok('新卡评「模糊」→ 离开新词池，不再被立刻重复抽到', () => {
  const s = schedule(newCardState(NOW), GRADES.HARD, NOW);
  assert.equal(s.state, 'learning', '新卡评模糊后状态不能还是 new');
  assert.ok(s.due > NOW, '到期时间必须往后推');
  const cards = [{ id: 'x', bucket: 'active', word: '甲', ...s }];
  assert.equal(buildQueue(cards, { now: NOW, dailyNewLimit: 20, newDoneCount: 0 }).length, 0, '未到期的学习卡不该进队列');
  assert.equal(isDue(s, NOW), false);
});

ok('新卡评「忘记」→ 也是 learning，10 分钟后', () => {
  const s = schedule(newCardState(NOW), GRADES.AGAIN, NOW);
  assert.equal(s.state, 'learning');
  assert.equal(s.due, NOW + 10 * 60000);
});

ok('易度因子下限 1.3（连评忘记 20 次不跌破）', () => {
  let s = { ...newCardState(NOW), state: 'review', interval: 10, ef: 2.5, step: 2 };
  for (let i = 0; i < 20; i += 1) {
    s = schedule(s, GRADES.AGAIN, NOW);
    s = { ...s, state: 'review' };
  }
  assert.equal(s.ef, EF_MIN);
  assert.ok(s.ef >= EF_MIN);
});

ok('间隔上限 365 天', () => {
  const base = { ...newCardState(NOW), state: 'review', interval: 300, ef: 3, step: 2 };
  const s = schedule(base, GRADES.GOOD, NOW);
  assert.equal(s.interval, 365);
});

ok('schedule 不修改入参（冻结探针）', () => {
  const base = Object.freeze({ ...newCardState(NOW), state: 'review', interval: 5, ef: 2.5, step: 2 });
  const s = schedule(base, GRADES.GOOD, NOW);
  assert.notEqual(s, base);
  assert.equal(base.interval, 5);
  assert.equal(base.reps, 0);
  assert.equal(s.reps, 1);
});

ok('schedule 拒绝非法评分', () => {
  assert.throws(() => schedule(newCardState(NOW), 9, NOW));
  assert.throws(() => schedule(null, GRADES.GOOD, NOW));
});

ok('isDue：新卡不算到期，到期卡算', () => {
  assert.equal(isDue(newCardState(NOW), NOW), false);
  const s = schedule(newCardState(NOW), GRADES.GOOD, NOW);
  assert.equal(isDue(s, NOW), false);
  assert.equal(isDue(s, NOW + DAY), true);
});

ok('describeInterval 人类可读', () => {
  assert.equal(describeInterval({ interval: 10 / 1440 }), '10 分钟');
  assert.equal(describeInterval({ interval: 3 }), '3 天');
  assert.equal(describeInterval({ interval: 0.5 }), '12 小时');
});

ok('buildQueue：旧卡按 due 升序，新卡每 5 张插 1 张', () => {
  const cards = [];
  for (let i = 0; i < 12; i += 1) cards.push({ id: 'd' + i, bucket: 'active', state: 'review', due: NOW - (i + 1) * 1000, interval: 1, ef: 2.5 });
  for (let i = 0; i < 6; i += 1) cards.push({ id: 'n' + i, bucket: 'active', ...newCardState(NOW) });
  cards.push({ id: 'm0', bucket: 'mastered', state: 'new', due: NOW });
  const q = buildQueue(cards, { now: NOW, dailyNewLimit: 20, newDoneCount: 0 });
  assert.equal(q.filter((c) => c.state === 'new').length, 6);
  assert.ok(!q.some((c) => c.bucket === 'mastered'), '已掌握卡不得进队列');
  assert.ok(q[0].id.startsWith('d'), '第一张应是到期旧卡');
  assert.equal(q.length, 18);
});

ok('buildQueue：每日新词上限与今日已学抵扣', () => {
  const cards = [];
  for (let i = 0; i < 5; i += 1) cards.push({ id: 'n' + i, bucket: 'active', ...newCardState(NOW) });
  assert.equal(buildQueue(cards, { now: NOW, dailyNewLimit: 2, newDoneCount: 0 }).length, 2);
  assert.equal(buildQueue(cards, { now: NOW, dailyNewLimit: 2, newDoneCount: 2 }).length, 0);
  assert.equal(buildQueue(cards, { now: NOW, dailyNewLimit: 10, newDoneCount: 3 }).length, 5, '额度 7 > 新卡 5，应全部给出');
  assert.equal(buildQueue(cards, { now: NOW, dailyNewLimit: 5, newDoneCount: 3 }).length, 2, '额度 2 应只给 2 张');
});

console.log(process.exitCode ? '\n有失败用例' : '\n全部通过：' + pass + ' 组');
