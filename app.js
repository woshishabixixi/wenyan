import { GRADES, schedule, newCardState, describeInterval, buildQueue } from './srs.js';
import * as db from './db.js';

const DECK_URL = './data/deck.builtin.json';
const DEFAULT_SETTINGS = { dailyNewLimit: 20, relearnGap: 4 };
const RELEARN_GAP_MIN = 3;   // 硬下限：模糊/不认识的词至少隔 3 张才回来
const RELEARN_GAP_MAX = 10;

function relearnGap() {
  const n = Number(state.settings.relearnGap);
  return Math.max(RELEARN_GAP_MIN, Math.min(RELEARN_GAP_MAX, Number.isFinite(n) && n ? n : 4));
}

const state = {
  route: 'review',
  cards: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  streak: { lastDate: '', count: 0 },
  newDone: { date: '', count: 0 },
  queue: [],
  relearn: [],
  peekedId: null,
  lastGraded: null,
  lastUndo: null,
  filter: 'all',
  today: { date: '', again: 0, hard: 0, good: 0 },
  favs: [],
  mode: 'review',
  quiz: { q: null, picked: null, n: 0 },
  search: '',
  editor: null,
  batch: '',
};

const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const bootErrorEl = document.getElementById('boot-error');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function yesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); }

function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 2200);
}

function bootError(msg) {
  if (!bootErrorEl) return;
  bootErrorEl.textContent = msg;
  bootErrorEl.hidden = false;
}

function describeUntil(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return '现在';
  const min = Math.round(diff / 60000);
  if (min < 60) return min + ' 分钟后';
  const hours = Math.round(min / 60);
  if (hours < 24) return hours + ' 小时后';
  return Math.round(hours / 24) + ' 天后';
}

/* ---------- 数据装载 ---------- */

async function ensureDeck() {
  const importedVersion = await db.getMeta('deckVersion', 0);
  const existing = await db.getAllCards();
  try {
    const res = await fetch(DECK_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const deck = await res.json();
    const version = deck.version || 1;
    // 词库没变就什么都不做，避免每次启动都写库
    if (importedVersion >= version && existing.length) return;

    const byId = new Map(existing.map((c) => [c.id, c]));
    const now = Date.now();
    const toWrite = [];
    let added = 0;
    let updated = 0;

    for (const c of deck.cards || []) {
      if (!c || !c.id) continue;
      const cur = byId.get(c.id);
      if (!cur) {
        toWrite.push({ ...c, origin: 'builtin', bucket: 'active', createdAt: now, masteredAt: 0, ...newCardState(now) });
        added += 1;
      } else if (cur.origin !== 'custom') {
        // 增量更新：只替换词条内容，state/due/ef/bucket 等复习进度原样保留
        toWrite.push({ ...cur, word: c.word, pinyin: c.pinyin, tags: c.tags, senses: c.senses });
        updated += 1;
      }
    }

    if (toWrite.length) await db.putCards(toWrite);
    await db.setMeta('deckVersion', version);

    if (!existing.length) toast('已导入内置词库 ' + added + ' 条');
    else if (added || updated) toast('词库已更新：新增 ' + added + ' 条 · 补充释义 ' + updated + ' 条');
  } catch (err) {
    bootError('词库文件加载失败（' + err.message + '）。你仍然可以手动添加词条，或检查 data/deck.builtin.json 是否存在。');
  }
}

/** 词库格式的卡片没有复习状态字段；补齐它，否则队列会整片空掉 */
function normalizeCard(c, now = Date.now()) {
  const base = newCardState(now);
  const out = { ...c };
  let changed = false;
  if (!out.bucket) { out.bucket = 'active'; changed = true; }
  if (!out.state) { out.state = base.state; changed = true; }
  if (typeof out.step !== 'number') { out.step = base.step; changed = true; }
  if (typeof out.ef !== 'number') { out.ef = base.ef; changed = true; }
  if (typeof out.interval !== 'number') { out.interval = base.interval; changed = true; }
  if (typeof out.due !== 'number') { out.due = now; changed = true; }
  if (typeof out.reps !== 'number') { out.reps = 0; changed = true; }
  if (typeof out.lapses !== 'number') { out.lapses = 0; changed = true; }
  if (!out.origin) { out.origin = 'builtin'; changed = true; }
  if (typeof out.createdAt !== 'number') { out.createdAt = now; changed = true; }
  if (typeof out.masteredAt !== 'number') { out.masteredAt = 0; changed = true; }
  if (!Array.isArray(out.senses)) { out.senses = []; changed = true; }
  return { card: out, changed };
}

async function loadAll() {
  const all = await db.getAllCards();
  const healed = [];
  state.cards = new Map();
  all.forEach((raw) => {
    const { card, changed } = normalizeCard(raw);
    state.cards.set(card.id, card);
    if (changed) healed.push(card);
  });
  if (healed.length) {
    db.putCards(healed).catch(() => {});
    console.warn('已修复 ' + healed.length + ' 张缺少复习状态的卡片');
  }
  const settings = await db.getMeta('settings', null);
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.streak = (await db.getMeta('streak', null)) || { lastDate: '', count: 0 };
  state.newDone = (await db.getMeta('newDone', null)) || { date: '', count: 0 };
  state.today = (await db.getMeta('todayStats', null)) || { date: '', again: 0, hard: 0, good: 0 };
  state.favs = (await db.getMeta('favs', null)) || [];
}

/* ---------- 队列 ---------- */

function newDoneToday() {
  return state.newDone.date === dayKey() ? state.newDone.count : 0;
}

async function buryCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  await persist({ ...card, buriedDay: dayKey() });
  state.relearn = state.relearn.filter((e) => e.id !== id);
  state.lastGraded = null;
  state.peekedId = null;
  rebuildQueue();
  render();
  toast('这张今天不再出现');
}

function rebuildQueue() {
  const today = dayKey();
  const list = Array.from(state.cards.values()).filter((c) => c.buriedDay !== today);
  let q = buildQueue(list, {
    now: Date.now(),
    dailyNewLimit: state.settings.dailyNewLimit,
    newDoneCount: newDoneToday(),
  }).map((c) => c.id);

  // 会话内重学：推迟名单按「还剩几张」倒计时插入，否则每次都重新数到第 5 张，永远追不上。
  state.relearn = state.relearn.filter((e) => {
    const c = state.cards.get(e.id);
    return !!c && c.bucket === 'active';
  });
  for (const e of state.relearn) {
    q = q.filter((x) => x !== e.id);
    const at = e.gap > 0 ? Math.min(e.gap, q.length) : 0;
    q.splice(at, 0, e.id);
  }
  state.queue = q;
}

function currentCard() {
  while (state.queue.length) {
    const card = state.cards.get(state.queue[0]);
    if (card && card.bucket === 'active') return card;
    state.queue.shift();
  }
  return null;
}

function nextDueAt() {
  let min = 0;
  state.cards.forEach((c) => {
    if (c.bucket !== 'active' || c.state === 'new') return;
    if (!min || c.due < min) min = c.due;
  });
  return min;
}

/* ---------- 状态写入 ---------- */

async function persist(card) {
  state.cards.set(card.id, card);
  await db.putCard(card);
}

function bumpTodayStats(grade, delta = 1) {
  const today = dayKey();
  const base = state.today.date === today ? state.today : { date: today, again: 0, hard: 0, good: 0 };
  const next = { ...base };
  if (grade === GRADES.AGAIN) next.again += delta;
  else if (grade === GRADES.HARD) next.hard += delta;
  else next.good += delta;
  next.again = Math.max(0, next.again);
  next.hard = Math.max(0, next.hard);
  next.good = Math.max(0, next.good);
  state.today = next;
  db.setMeta('todayStats', state.today);
}

function reviewedToday() {
  if (state.today.date !== dayKey()) return 0;
  return state.today.again + state.today.hard + state.today.good;
}

async function undoLast() {
  const u = state.lastUndo;
  if (!u) { toast('没有可撤销的操作'); return; }
  await persist(u.card);
  state.relearn = u.relearn;
  if (u.wasNew) {
    const today = dayKey();
    if (state.newDone.date === today && state.newDone.count > 0) {
      state.newDone = { date: today, count: state.newDone.count - 1 };
      db.setMeta('newDone', state.newDone);
    }
  }
  bumpTodayStats(u.grade, -1);
  state.lastUndo = null;
  state.lastGraded = null;
  state.peekedId = null;
  rebuildQueue();
  state.queue = [u.card.id, ...state.queue.filter((id) => id !== u.card.id)];
  render();
  toast('已撤销上一张');
}

function bumpNewDone() {
  const today = dayKey();
  const count = (state.newDone.date === today ? state.newDone.count : 0) + 1;
  state.newDone = { date: today, count };
  db.setMeta('newDone', state.newDone);
}

function bumpStreak() {
  const today = dayKey();
  if (state.streak.lastDate === today) return;
  const count = state.streak.lastDate === yesterdayKey() ? state.streak.count + 1 : 1;
  state.streak = { lastDate: today, count };
  db.setMeta('streak', state.streak);
}

async function gradeCard(g) {
  const card = currentCard();
  if (!card) return;
  const wasNew = card.state === 'new';
  state.lastUndo = { card: { ...card }, relearn: state.relearn.map((e) => ({ ...e })), wasNew, grade: g };
  const patched = { ...card, ...schedule(card, g, Date.now()) };
  await persist(patched);
  db.logReview({ id: card.id, grade: g });
  if (wasNew) bumpNewDone();
  bumpStreak();
  bumpTodayStats(g);
  state.peekedId = null;
  state.lastGraded = { id: card.id, grade: g }; // 停在这张的答案上，等用户看完再「下一张」
  // 模糊 / 不认识：进「推迟名单」，本次会话内隔几张再抽回来；评「认识」则从名单移除
  if (g === GRADES.GOOD) {
    state.relearn = state.relearn.filter((e) => e.id !== card.id);
  } else {
    const gap = relearnGap();
    const hit = state.relearn.find((e) => e.id === card.id);
    if (hit) hit.gap = gap;
    else state.relearn.push({ id: card.id, gap });
  }
  // 每复习一张别的卡，推迟卡的倒计时就减 1
  state.relearn.forEach((e) => { if (e.id !== card.id) e.gap = Math.max(0, e.gap - 1); });
  rebuildQueue();
  render();
}

async function masterCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  await persist({ ...card, bucket: 'mastered', masteredAt: Date.now() });
  state.peekedId = null;
  state.lastGraded = null;
  rebuildQueue();
  render();
  toast('已移入「已掌握」，可在该页恢复');
}

async function restoreCard(id) {
  const card = state.cards.get(id);
  if (!card) return;
  const now = Date.now();
  await persist({ ...card, bucket: 'active', state: 'review', step: 2, due: now, interval: 1, ef: Math.max(card.ef || 2.5, 1.3) });
  rebuildQueue();
  render();
  toast('已恢复到复习队列');
}

/* ---------- 视图 ---------- */

function renderStats() {
  const now = Date.now();
  const due = Array.from(state.cards.values()).filter((c) => c.bucket === 'active' && c.state !== 'new' && c.due <= now).length;
  const fresh = Array.from(state.cards.values()).filter((c) => c.bucket === 'active' && c.state === 'new').length;
  const elapsed = state.streak.lastDate === dayKey() || state.streak.lastDate === yesterdayKey() ? state.streak.count : 0;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = String(v); };
  set('stat-due', due);
  set('stat-new', Math.min(fresh, Math.max(0, state.settings.dailyNewLimit - newDoneToday())));
  set('stat-streak', elapsed);
}

function renderSenses(card) {
  const senses = Array.isArray(card.senses) && card.senses.length ? card.senses : [{ pos: '', def: '（暂无释义）' }];
  const body = senses.map((s, si) => {
    const exs = senseExamples(s).map((e, ei) => {
      const on = isFav(card.id, e.text);
      return '<div class="sense-ex">'
        + '<button class="fav' + (on ? ' is-on' : '') + '" data-action="fav" data-id="' + esc(card.id) + '" data-si="' + si + '" data-ei="' + ei + '" type="button" title="收藏这句">' + (on ? '★' : '☆') + '</button>'
        + '<span class="ex-text">' + esc(e.text)
        + (e.source ? ' <span class="src">—— ' + esc(e.source) + '</span>' : '') + '</span>'
        + (e.translation ? '<div class="tr">' + esc(e.translation) + '</div>' : '')
        + '</div>';
    }).join('');
    const ex = exs;
    return '<div class="sense">'
      + (s.pos ? '<span class="sense-pos">' + esc(s.pos) + '</span>' : '')
      + (s.rare ? '<span class="sense-rare">少考</span>' : '')
      + '<span class="sense-def">' + esc(s.def) + '</span>' + ex + '</div>';
  }).join('');
  const tags = Array.isArray(card.tags) && card.tags.length
    ? '<div class="tags">' + card.tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>'
    : '';
  return '<div class="senses">' + body + tags + '</div>';
}

const GRADE_LABEL = { 0: '不认识', 1: '模糊', 2: '认识' };

/** 兼容老数据：单条例句写成 example，多条例句写成 examples */
function senseExamples(sense) {
  if (!sense) return [];
  if (Array.isArray(sense.examples)) return sense.examples.filter((e) => e && e.text);
  if (sense.example && sense.example.text) return [sense.example];
  return [];
}

function favKey(cardId, text) { return cardId + '' + text; }

function isFav(cardId, text) {
  const k = favKey(cardId, text);
  return state.favs.some((f) => favKey(f.cardId, f.text) === k);
}

async function toggleFav(card, ex, sense) {
  const k = favKey(card.id, ex.text);
  const idx = state.favs.findIndex((f) => favKey(f.cardId, f.text) === k);
  if (idx >= 0) {
    state.favs.splice(idx, 1);
    toast('已取消收藏');
  } else {
    state.favs.unshift({
      cardId: card.id,
      word: card.word,
      pos: (sense && sense.pos) || '',
      def: (sense && sense.def) || '',
      text: ex.text,
      source: ex.source || '',
      translation: ex.translation || '',
      at: Date.now(),
    });
    toast('已收藏这句例句');
  }
  await db.setMeta('favs', state.favs);
  render();
}
const LEECH_LAPSES = 3; // 连续遗忘达到这个次数，自动标成「难词」

function renderProgress() {
  const done = reviewedToday();
  const remain = state.queue.length;
  const all = done + remain;
  const pct = all ? Math.round((done / all) * 100) : 0;
  return '<div class="progress"><div class="progress-bar"><i style="width:' + pct + '%"></i></div>'
    + '<div class="progress-text">今日进度 ' + done + ' / ' + all + '</div></div>';
}

/** 评分后的答案页：显示这张的完整释义，等用户看完点「下一张」 */
function renderAnswer() {
  const g = state.lastGraded;
  const card = state.cards.get(g.id);
  if (!card) { state.lastGraded = null; renderReview(); return; }
  view.innerHTML = '<div class="review-card is-answered">'
    + '<span class="answered-tag" data-g="' + g.grade + '">已记录 · ' + esc(GRADE_LABEL[g.grade]) + '</span>'
    + '<div class="word">' + esc(card.word) + '</div>'
    + '<div class="pinyin">' + (card.pinyin ? '/' + esc(card.pinyin) + '/' : '')
    + '<button class="speak" data-action="speak-answer" type="button">🔊</button></div>'
    + renderSenses(card)
    + '<div class="answered-foot">下次复习：' + esc(describeUntil(card.due)) + '</div>'
    + '</div>'
    + '<div class="next-bar"><button class="btn primary btn-wide" data-action="next-card" type="button">下一张</button></div>';
}

function renderModeSwitch() {
  return '<div class="seg">'
    + '<button class="seg-btn' + (state.mode === 'review' ? ' is-on' : '') + '" data-action="mode" data-m="review" type="button">卡片复习</button>'
    + '<button class="seg-btn' + (state.mode === 'quiz' ? ' is-on' : '') + '" data-action="mode" data-m="quiz" type="button">例句填空</button>'
    + '</div>';
}

/** 出一道「这句里这个字是什么意思」的选择题：同词的其他义项优先做干扰项 */
function buildQuiz() {
  const pool = [];
  state.cards.forEach((c) => {
    if (c.bucket !== 'active') return;
    (c.senses || []).forEach((s, si) => {
      const exs = senseExamples(s);
      if (!exs.length || !s.def) return;
      pool.push({ card: c, si, sense: s, ex: exs[Math.floor(Math.random() * exs.length)] });
    });
  });
  if (!pool.length) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  const opts = new Map();
  opts.set(pick.sense.def, true);
  // 干扰项优先级：同一个词的其他义项 → 同词性的义项 → 随便
  (pick.card.senses || []).forEach((s, i) => {
    if (i !== pick.si && s.def && !opts.has(s.def) && opts.size < 4) opts.set(s.def, false);
  });
  const samePos = pool.filter((p) => p.sense.pos && p.sense.pos === pick.sense.pos);
  let guard = 0;
  while (opts.size < 4 && guard < 300) {
    guard += 1;
    const src = samePos.length > guard - 1 ? samePos : pool;
    const other = src[Math.floor(Math.random() * src.length)];
    if (other && other.sense.def && !opts.has(other.sense.def)) opts.set(other.sense.def, false);
  }
  const options = Array.from(opts.entries()).map(([def, ok]) => ({ def, ok }));
  for (let i = options.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = options[i]; options[i] = options[j]; options[j] = t;
  }
  return { cardId: pick.card.id, word: pick.card.word, ex: pick.ex, options, right: pick.sense.def };
}

function renderQuiz() {
  if (!state.quiz.q) state.quiz.q = buildQuiz();
  const q = state.quiz.q;
  if (!q) {
    view.innerHTML = renderModeSwitch() + '<div class="empty"><strong>还没有可用来出题的例句</strong>等词库里有带例句的词条后就能练了。</div>';
    return;
  }
  const picked = state.quiz.picked;
  const exText = String(q.ex.text).split(q.word).join('<b class="quiz-w">' + esc(q.word) + '</b>');
  const options = q.options.map((o, i) => {
    let cls = 'quiz-opt';
    if (picked !== null) {
      if (o.ok) cls += ' is-right';
      else if (i === picked) cls += ' is-wrong';
    }
    return '<button class="' + cls + '" data-action="answer" data-i="' + i + '" type="button">'
      + '<span class="quiz-idx">' + 'ABCD'[i] + '</span>' + esc(o.def) + '</button>';
  }).join('');

  const feedback = picked === null ? '' : '<div class="quiz-result ' + (q.options[picked].ok ? 'ok' : 'no') + '">'
    + (q.options[picked].ok ? '✅ 答对了' : '❌ 正确答案：' + esc(q.right))
    + '</div>'
    + '<div class="sense-ex quiz-trans"><span class="ex-text">译文：' + esc(q.ex.translation || '（这条暂无译文）')
    + (q.ex.source ? ' <span class="src">—— ' + esc(q.ex.source) + '</span>' : '') + '</span></div>'
    + '<div class="next-bar"><button class="btn primary btn-wide" data-action="next-quiz" type="button">下一题</button></div>';

  view.innerHTML = renderModeSwitch()
    + '<div class="review-card is-answered is-quiz">'
    + '<span class="badge">例句填空 · 第 ' + ((state.quiz.n || 0) + 1) + ' 题</span>'
    + '<div class="quiz-ex">' + exText + '</div>'
    + '<div class="quiz-ask">这句里的「' + esc(q.word) + '」是什么意思？</div>'
    + '</div>'
    + '<div class="quiz-opts">' + options + '</div>'
    + feedback;
}

function renderReview() {
  if (state.mode === 'quiz') { renderQuiz(); return; }
  if (state.lastGraded) { renderAnswer(); return; }
  const card = currentCard();
  if (!card) {
    const at = nextDueAt();
    view.innerHTML = '<div class="empty"><strong>今天背完了</strong>'
      + (at ? '下次复习 ' + esc(describeUntil(at)) : '还没有待复习的卡片')
      + '<br><span style="font-size:13px">可在「词库」添加生词，或在「设置」调高每日新词上限</span></div>';
    return;
  }
  const peeked = state.peekedId === card.id;
  const leech = (card.lapses || 0) >= LEECH_LAPSES
    ? '<span class="leech">难词 ×' + esc(String(card.lapses)) + '</span>' : '';
  view.innerHTML = renderModeSwitch() + renderProgress()
    + '<div class="review-card" data-action="peek">'
    + '<span class="badge">' + esc((card.tags && card.tags[0]) || (card.state === 'new' ? '新词' : '复习')) + leech + '</span>'
    + '<div class="word">' + esc(card.word) + '</div>'
    + '<div class="pinyin">' + (card.pinyin ? '/' + esc(card.pinyin) + '/' : '') + '<button class="speak" data-action="speak" type="button">🔊</button></div>'
    + (peeked ? renderSenses(card) : '<div class="hint">先在脑子里回想释义<br>判断完下面三档，立刻显示答案</div>')
    + '<div class="card-foot">'
    + (peeked
      ? '<button class="link-btn" data-action="unpeek" type="button">收起释义</button>'
      : '<button class="link-btn" data-action="peek" type="button">想不起来，先看答案</button>')
    + '<button class="link-btn" data-action="master" type="button">太简单 · 移入已掌握</button></div>'
    + '</div>'
    + '<div class="grade-bar">'
    + '<button class="grade" data-action="grade" data-g="0" type="button">不认识</button>'
    + '<button class="grade" data-action="grade" data-g="1" type="button">模糊</button>'
    + '<button class="grade" data-action="grade" data-g="2" type="button">认识</button>'
    + '<button class="grade grade-bury" data-action="bury" type="button">今天<br>不再出现</button>'
    + '</div>'
    + '<div class="grade-note">' + (card.reps ? '已复习 ' + esc(String(card.reps)) + ' 次' : '新词 · 第一次复习') + ' · 点按钮后显示释义'
    + (state.lastUndo ? ' · <button class="inline-link" data-action="undo" type="button">撤销上一张</button>' : '') + '</div>';
}

/** 老收藏没存释义，按例句反查一次 */
function lookupDefByExample(f) {
  const card = state.cards.get(f.cardId);
  if (!card) return '';
  for (const s of card.senses || []) {
    if (senseExamples(s).some((e) => e.text === f.text)) return s.def || '';
  }
  return '';
}

function renderFavs() {
  if (!state.favs.length) {
    view.innerHTML = '<div class="empty"><strong>还没有收藏的例句</strong>背词时，每条例句左边有个 ☆，点一下就把这句收进来，方便集中回看。</div>';
    return;
  }
  view.innerHTML = '<div class="section" style="padding:12px 14px">共 ' + state.favs.length + ' 条例句收藏</div>'
    + state.favs.map((f, i) => '<div class="row"><div class="row-main">'
      + '<div class="row-word">' + esc(f.word || '') + '</div>'
      + '<div class="fav-def">' + (f.pos ? '<span class="sense-pos">' + esc(f.pos) + '</span>' : '')
      + esc(f.def || lookupDefByExample(f) || '（这条收藏没有释义，可在卡片里重新收藏）') + '</div>'
      + '<div class="fav-ex">' + esc(f.text) + (f.source ? ' <span class="src">—— ' + esc(f.source) + '</span>' : '') + '</div>'
      + (f.translation ? '<div class="row-sub">' + esc(f.translation) + '</div>' : '')
      + '</div><button class="btn" data-action="unfav" data-fi="' + i + '" type="button">取消</button></div>').join('');
}

function renderMastered() {
  const list = Array.from(state.cards.values())
    .filter((c) => c.bucket === 'mastered')
    .sort((a, b) => (b.masteredAt || 0) - (a.masteredAt || 0));
  if (!list.length) {
    view.innerHTML = '<div class="empty"><strong>还没有已掌握的词</strong>在复习页点「太简单 · 移入已掌握」，词会存到这里，不再出现在复习队列。</div>';
    return;
  }
  view.innerHTML = '<div class="section" style="padding:12px 14px">共 ' + list.length + ' 条已掌握。恢复后会立刻回到复习队列。</div>'
    + list.map((c) => {
      const def = (c.senses && c.senses[0] && c.senses[0].def) || '';
      return '<div class="row"><div class="row-main"><div class="row-word">' + esc(c.word) + '</div>'
        + '<div class="row-sub">' + esc(def) + '</div></div>'
        + '<button class="btn" data-action="restore" data-id="' + esc(c.id) + '" type="button">恢复</button></div>';
    }).join('');
}

function senseSummary(card) {
  const s = (card.senses || [])[0];
  return s && s.def ? s.def : '';
}

function emptySense() {
  return { pos: '', def: '', exText: '', exSrc: '', rare: false };
}

function renderEditor() {
  const e = state.editor || { word: '', pinyin: '', senses: [emptySense()] };
  const isEdit = !!e.id;
  const senses = e.senses && e.senses.length ? e.senses : [emptySense()];

  const blocks = senses.map((s, i) => '<div class="sense-block">'
    + '<div class="sense-head">解释 ' + (i + 1)
    + (senses.length > 1 ? '<button class="link-btn" data-action="remove-sense" data-i="' + i + '" type="button">删除这条</button>' : '')
    + '</div>'
    + '<label class="check"><input type="checkbox" id="f-rare-' + i + '"' + (s.rare ? ' checked' : '') + '> 不常考（在释义前显示「少考」标记）</label>'
    + '<div class="field"><label>词性</label><input id="f-pos-' + i + '" value="' + esc(s.pos) + '" placeholder="动 / 名 / 形 / 副 / 代 / 助"></div>'
    + '<div class="field"><label>释义</label><input id="f-def-' + i + '" value="' + esc(s.def) + '" placeholder="如 跑；逃跑"></div>'
    + '<div class="field"><label>例句（可空）</label><input id="f-ext-' + i + '" value="' + esc(s.exText) + '"></div>'
    + '<div class="field"><label>出处（可空）</label><input id="f-exs-' + i + '" value="' + esc(s.exSrc) + '"></div>'
    + '</div>').join('');

  return '<div class="section"><h2>' + (isEdit ? '编辑词条' : '新增词条') + '</h2>'
    + '<div class="field"><label>词</label><input id="f-word" value="' + esc(e.word) + '" placeholder="如 走"></div>'
    + '<div class="field"><label>拼音（可空）</label><input id="f-pinyin" value="' + esc(e.pinyin) + '" placeholder="如 zǒu"></div>'
    + blocks
    + '<div class="actions"><button class="btn" data-action="add-sense" type="button">+ 再加一条解释</button></div>'
    + '<div class="actions" style="margin-top:10px"><button class="btn primary" data-action="save-card" type="button">保存</button>'
    + '<button class="btn ghost" data-action="cancel-card" type="button">取消</button></div></div>';
}

/** 把编辑器里的所有字段读回 state.editor（加/减义项前必须先读，否则已输入内容会丢） */
function syncEditorFromForm() {
  const e = state.editor;
  if (!e) return null;
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const senses = (e.senses || []).map((s, i) => {
    const chk = document.getElementById('f-rare-' + i);
    return {
      pos: val('f-pos-' + i),
      def: val('f-def-' + i),
      exText: val('f-ext-' + i),
      exSrc: val('f-exs-' + i),
      rare: !!(chk && chk.checked),
    };
  });
  state.editor = { ...e, word: val('f-word'), pinyin: val('f-pinyin'), senses };
  return state.editor;
}

const FILTERS = [
  ['all', '全部'],
  ['new', '未学'],
  ['learning', '在学'],
  ['leech', '难词'],
  ['mastered', '已掌握'],
];

function matchesFilter(card) {
  switch (state.filter) {
    case 'new': return card.bucket === 'active' && card.state === 'new';
    case 'learning': return card.bucket === 'active' && card.state !== 'new';
    case 'leech': return card.bucket === 'active' && (card.lapses || 0) >= LEECH_LAPSES;
    case 'mastered': return card.bucket === 'mastered';
    default: return true;
  }
}

function renderLibrary() {
  const q = state.search.trim();
  const list = Array.from(state.cards.values())
    .filter(matchesFilter)
    .filter((c) => !q || c.word.includes(q) || senseSummary(c).includes(q))
    .sort((a, b) => (a.word > b.word ? 1 : a.word < b.word ? -1 : 0))
    .slice(0, 300);

  const chips = '<div class="chips">' + FILTERS.map(([k, label]) => {
    const n = Array.from(state.cards.values()).filter((c) => {
      const keep = state.filter; state.filter = k; const ok = matchesFilter(c); state.filter = keep; return ok;
    }).length;
    return '<button class="chip' + (state.filter === k ? ' is-on' : '') + '" data-action="filter" data-f="' + k + '" type="button">'
      + esc(label) + ' ' + n + '</button>';
  }).join('') + '</div>';

  const head = '<div class="list-head"><input class="search" id="search" value="' + esc(state.search) + '" placeholder="搜索词或释义">'
    + '<button class="btn primary" data-action="new-card" type="button">+ 新增</button></div>';

  const rows = list.map((c) => '<div class="row"><div class="row-main"><div class="row-word">' + esc(c.word)
    + (c.bucket === 'mastered' ? ' <span class="tag">已掌握</span>' : '')
    + '</div><div class="row-sub">' + esc(senseSummary(c)) + '</div></div>'
    + '<button class="btn" data-action="edit-card" data-id="' + esc(c.id) + '" type="button">编辑</button>'
    + '<button class="btn danger" data-action="drop-card" data-id="' + esc(c.id) + '" type="button">删除</button></div>').join('');

  view.innerHTML = (state.editor !== null ? renderEditor() : '')
    + head + chips
    + (list.length ? rows : '<div class="empty"><strong>没有匹配的词条</strong>换个关键词，或点「+ 新增」自己加。</div>')
    + '<div class="section"><h2>批量粘贴导入</h2>'
    + '<p class="sub">每行一条。最省事：<b>一行一个词</b>（释义之后再补）；也可以写「词 释义」或「词 拼音 释义」；'
    + '完整格式用竖线：词|拼音|词性|释义|例句|出处。重复的词会自动跳过。</p>'
    + '<div class="field"><textarea id="batch" placeholder="走|zǒu|动|跑；逃跑|弃甲曳兵而走|《寡人之于国也》">' + esc(state.batch) + '</textarea></div>'
    + '<div class="actions"><button class="btn primary" data-action="batch-import" type="button">导入</button></div></div>';
}

function forecast7() {
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  const n = new Date();
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  state.cards.forEach((c) => {
    if (c.bucket !== 'active' || c.state === 'new') return;
    const d = Math.floor((c.due - start) / 86400000);
    if (d < 0) buckets[0] += 1;
    else if (d < 7) buckets[d] += 1;
  });
  return buckets;
}

function renderForecast() {
  const b = forecast7();
  const max = Math.max(1, ...b);
  const labels = ['今', '明', '后', '3', '4', '5', '6'];
  return '<div class="forecast">' + b.map((v, i) => '<div class="fc-col">'
    + '<div class="fc-bar-wrap"><div class="fc-bar" style="height:' + Math.round((v / max) * 100) + '%"></div></div>'
    + '<div class="fc-num">' + v + '</div>'
    + '<div class="fc-day">' + labels[i] + '</div></div>').join('') + '</div>';
}

function renderSettings() {
  db.countCards().then((n) => {
    const el = document.getElementById('stats-line');
    if (el) el.textContent = '共 ' + n.total + ' 条 · 在学 ' + n.active + ' · 已掌握 ' + n.mastered;
  }).catch(() => {});
  const t = state.today.date === dayKey() ? state.today : { again: 0, hard: 0, good: 0 };
  view.innerHTML = '<div class="section"><h2>今天</h2>'
    + '<p class="sub">已复习 ' + reviewedToday() + ' 张 · 认识 ' + t.good + ' · 模糊 ' + t.hard + ' · 不认识 ' + t.again + '</p></div>'
    + '<div class="section"><h2>未来 7 天到期</h2><p class="sub">这些卡会在对应那天排进复习队列。</p>' + renderForecast() + '</div>'
    + '<div class="section"><h2>每日新词上限</h2>'
    + '<p class="sub">每天最多引入多少张新卡。学过的旧卡不受此限制，到点就会排进队列。</p>'
    + '<div class="field"><input id="f-limit" type="number" min="0" max="200" value="' + esc(state.settings.dailyNewLimit) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-limit" type="button">保存</button></div></div>'
    + '<div class="section"><h2>不认识的词，隔几张再出现</h2>'
    + '<p class="sub">点「模糊」或「不认识」后，这张卡会在同一轮里隔几张再绕回来，直到你评一次「认识」。'
    + '范围 3–10 张，默认 4。设小了当天就能补好几遍，设大了每张词之间的压力更小。</p>'
    + '<div class="field"><input id="f-gap" type="number" min="' + RELEARN_GAP_MIN + '" max="' + RELEARN_GAP_MAX + '" value="' + esc(relearnGap()) + '"></div>'
    + '<div class="actions"><button class="btn primary" data-action="save-gap" type="button">保存</button></div></div>'
    + '<div class="section"><h2>数据备份</h2>'
    + '<p class="sub">所有数据只存在这台设备的浏览器里。换手机前请先导出，导入会覆盖当前全部数据。</p>'
    + '<div class="actions"><button class="btn primary" data-action="export" type="button">导出 JSON</button>'
    + '<button class="btn" data-action="import" type="button">导入备份</button>'
    + '<input id="file" type="file" accept="application/json,.json" hidden></div></div>'
    + '<div class="section"><h2>统计</h2><p class="sub" id="stats-line">统计中…</p>'
    + '<div class="actions"><button class="btn danger" data-action="reset" type="button">重置全部数据</button></div></div>'
    + '<div class="section"><h2>间隔算法</h2><p class="sub">三档评分驱动：<b>认识</b>把间隔乘以易度因子（2.5 起，最高 3.0），'
    + '<b>模糊</b>只乘 1.2 并降低易度，<b>不认识</b>直接回到 10 分钟后的重学。易度因子最低 1.3，最长间隔 365 天。</p></div>';
}

function render() {
  renderStats();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.route === state.route));
  if (!view) return;
  if (state.route === 'review') renderReview();
  else if (state.route === 'favs') renderFavs();
  else if (state.route === 'mastered') renderMastered();
  else if (state.route === 'library') renderLibrary();
  else renderSettings();
}

/* ---------- 导入导出 ---------- */

function cardFromDraft(draft, existing) {
  const senses = (draft.senses || []).filter((s) => s && s.def).map((s) => {
    const out = { pos: s.pos || '', def: s.def };
    const list = [];
    if (s.exText) list.push({ text: s.exText, source: s.exSrc || '', translation: '' });
    (s.extras || []).forEach((e) => { if (e && e.text) list.push(e); });
    if (list.length) out.examples = list;
    if (s.rare) out.rare = true;
    return out;
  });
  const base = existing || {
    id: 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    origin: 'custom', bucket: 'active', createdAt: Date.now(), masteredAt: 0, ...newCardState(Date.now()),
  };
  return {
    ...base,
    word: draft.word,
    pinyin: draft.pinyin,
    senses: senses.length ? senses : [{ pos: '', def: '（待补充释义）' }],
    tags: base.tags && base.tags.length ? base.tags : ['自建'],
  };
}

async function saveCard() {
  const draft = syncEditorFromForm();
  if (!draft) return;
  if (!draft.word) { toast('至少要填「词」'); return; }
  if (!(draft.senses || []).some((s) => s.def)) { toast('至少要填一条释义'); return; }
  const editingId = state.editor && state.editor.id;
  const existing = editingId ? state.cards.get(editingId) : null;
  const dup = Array.from(state.cards.values()).find((c) => c.word === draft.word && c.id !== editingId);
  if (dup) { toast('「' + draft.word + '」已存在'); return; }
  const card = cardFromDraft(draft, existing);
  await persist(card);
  state.editor = null;
  rebuildQueue();
  render();
  toast(existing ? '已保存修改' : '已添加，将按新词安排复习');
}

// 覆盖全部带调拼音字母（含 ǎǐǒǔě 等第三声元音），Latin-1 + Latin Extended-A/B + 组合声调符
const PINYIN_RE = /^[a-zA-Z\u00C0-\u024F\u0300-\u036f]{1,24}$/;

/** 一行一条。支持三种写法：
 *  词|拼音|词性|释义|例句|出处     （完整格式，后几项可省）
 *  词 释义                        （从 Word/微信里直接粘的常见形态）
 *  词                              （只有词，释义留待补充） */
function parseImportLine(line) {
  const raw = line.trim();
  if (raw.includes('|')) {
    const p = raw.split('|').map((s) => s.trim());
    return { word: p[0], pinyin: p[1] || '', pos: p[2] || '', def: p[3] || '', exText: p[4] || '', exSrc: p[5] || '' };
  }
  const parts = raw.split(/[\s\u3000]+/).filter(Boolean);
  const word = parts[0] || '';
  // 连续多个拼音音节要合并（如「囹圄 líng yǔ 监狱」），否则释义会被吃掉一段
  let idx = 1;
  const py = [];
  while (idx < parts.length && py.length < 4 && parts[idx] !== word && PINYIN_RE.test(parts[idx])) {
    py.push(parts[idx]);
    idx += 1;
  }
  return { word, pinyin: py.join(' '), pos: '', def: parts.slice(idx).join(' '), exText: '', exSrc: '' };
}

async function batchImport() {
  const ta = document.getElementById('batch');
  const text = ta ? ta.value : '';
  state.batch = text;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) { toast('没有可导入的内容'); return; }
  const words = new Set(Array.from(state.cards.values()).map((c) => c.word));
  const now = Date.now();
  const fresh = [];
  let skipped = 0;
  lines.forEach((line) => {
    const p = parseImportLine(line);
    const word = p.word;
    if (!word || words.has(word)) { skipped += 1; return; }
    const rawDef = p.def || '';
    const rare = rawDef.startsWith('*');
    const sense = { pos: p.pos || '', def: rare ? rawDef.slice(1).trim() || '（待补充释义）' : (rawDef || '（待补充释义）') };
    if (rare) sense.rare = true;
    if (p.exText) sense.examples = [{ text: p.exText, source: p.exSrc || '', translation: '' }];
    words.add(word);
    fresh.push({
      id: 'custom-' + now.toString(36) + '-' + String(fresh.length).padStart(3, '0'),
      word, pinyin: p[1] || '', senses: [sense], tags: ['自建'],
      origin: 'custom', bucket: 'active', createdAt: now, masteredAt: 0, ...newCardState(now),
    });
  });
  if (fresh.length) {
    await db.putCards(fresh);
    fresh.forEach((c) => state.cards.set(c.id, c));
    state.batch = '';
  }
  rebuildQueue();
  render();
  toast('导入 ' + fresh.length + ' 条，跳过 ' + skipped + ' 条重复/空行');
}

function exportAll() {
  const payload = {
    app: 'wenyan-srs',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    streak: state.streak,
    newDone: state.newDone,
    cards: Array.from(state.cards.values()),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const d = new Date();
  const name = 'wenyan-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已导出 ' + name);
}

async function importAll(file) {
  if (!file) return;
  if (!confirm('导入会覆盖当前全部数据，确定继续？')) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.cards)) throw new Error('文件格式不对');

    // 闸门：词库文件（deck）不是备份。它只有词条内容、没有复习状态，
    // 直接导入会清空进度、并把队列搞空，所以这里必须拦住。
    const isDeck = !data.app || !data.cards.every((c) => c && c.state && c.bucket);
    if (isDeck) {
      bootError('这不是备份文件，是词库文件。词库会自动更新，不需要导入；'
        + '如果你要恢复自己的复习进度，请在「设置 → 导出 JSON」生成的那个文件里再导入。');
      return;
    }
    await db.clearAll();
    await db.putCards(data.cards);
    if (data.settings) await db.setMeta('settings', data.settings);
    if (data.streak) await db.setMeta('streak', data.streak);
    if (data.newDone) await db.setMeta('newDone', data.newDone);
    await db.setMeta('deckVersion', 1);
    state.relearn = [];
    await loadAll();
    rebuildQueue();
    render();
    toast('已导入 ' + data.cards.length + ' 条');
  } catch (err) {
    bootError('导入失败：' + err.message);
  }
}

/* ---------- 事件 ---------- */

function speak(text) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (err) { /* 不支持就静默 */ }
}

const tabs = document.getElementById('tabs');
if (tabs) {
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-route]');
    if (!btn) return;
    state.route = btn.dataset.route;
    state.peekedId = null;
    state.lastGraded = null;
    state.editor = null;
    render();
  });
}

if (view) {
  view.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (['grade', 'master', 'speak', 'speak-answer', 'next-card', 'bury', 'fav', 'mode', 'answer', 'next-quiz'].indexOf(action) >= 0) e.stopPropagation();
    if (action === 'peek') {
      const c = currentCard();
      if (c) { state.peekedId = c.id; render(); }
      return;
    }
    if (action === 'unpeek') { state.peekedId = null; render(); return; }
    if (action === 'undo') { await undoLast(); return; }
    if (action === 'mode') {
      state.mode = el.dataset.m === 'quiz' ? 'quiz' : 'review';
      state.quiz = { q: null, picked: null, n: 0 };
      state.lastGraded = null;
      state.peekedId = null;
      render();
      return;
    }
    if (action === 'answer') {
      if (state.quiz.picked !== null) return;
      state.quiz.picked = Number(el.dataset.i);
      render();
      return;
    }
    if (action === 'next-quiz') {
      state.quiz = { q: null, picked: null, n: (state.quiz.n || 0) + 1 };
      render();
      return;
    }
    if (action === 'bury') { const c = currentCard(); if (c) await buryCard(c.id); return; }
    if (action === 'fav') {
      const card = state.cards.get(el.dataset.id);
      const s = card && card.senses ? card.senses[Number(el.dataset.si)] : null;
      const ex = s ? senseExamples(s)[Number(el.dataset.ei)] : null;
      if (card && ex) await toggleFav(card, ex, s);
      return;
    }
    if (action === 'unfav') {
      const i = Number(el.dataset.fi);
      if (i >= 0 && i < state.favs.length) {
        state.favs.splice(i, 1);
        await db.setMeta('favs', state.favs);
        render();
        toast('已取消收藏');
      }
      return;
    }
    if (action === 'filter') {
      state.filter = el.dataset.f || 'all';
      renderLibrary();
      return;
    }
    if (action === 'next-card') { state.lastGraded = null; state.peekedId = null; render(); return; }
    if (action === 'speak') {
      const card = currentCard();
      if (card) speak(card.word);
      return;
    }
    if (action === 'speak-answer') {
      const g = state.lastGraded;
      const c = g ? state.cards.get(g.id) : null;
      if (c) speak(c.word);
      return;
    }
    if (action === 'grade') { await gradeCard(Number(el.dataset.g)); return; }
    if (action === 'master') { const c = currentCard(); if (c) await masterCard(c.id); return; }
    if (action === 'restore') { await restoreCard(el.dataset.id); return; }
    if (action === 'new-card') { state.editor = { word: '', pinyin: '', senses: [emptySense()] }; render(); return; }
    if (action === 'edit-card') {
      const c = state.cards.get(el.dataset.id);
      if (!c) return;
      state.editor = {
        id: c.id,
        word: c.word,
        pinyin: c.pinyin || '',
        senses: (c.senses || []).map((s) => {
          const exs = senseExamples(s);
          return {
            pos: s.pos || '',
            def: s.def || '',
            exText: (exs[0] && exs[0].text) || '',
            exSrc: (exs[0] && exs[0].source) || '',
            rare: !!s.rare,
            extras: exs.slice(1), // 其余例句不在表单里编辑，但必须原样保留
          };
        }),
      };
      if (!state.editor.senses.length) state.editor.senses = [emptySense()];
      render();
      return;
    }
    if (action === 'drop-card') {
      const c = state.cards.get(el.dataset.id);
      if (!c) return;
      if (!confirm('把「' + c.word + '」移入已掌握库？之后不再推送，可在「已掌握」页恢复。')) return;
      await masterCard(c.id);
      return;
    }
    if (action === 'add-sense') {
      syncEditorFromForm();
      state.editor.senses.push(emptySense());
      render();
      return;
    }
    if (action === 'remove-sense') {
      syncEditorFromForm();
      const i = Number(el.dataset.i);
      if (state.editor.senses.length > 1) state.editor.senses.splice(i, 1);
      render();
      return;
    }
    if (action === 'save-card') { await saveCard(); return; }
    if (action === 'cancel-card') { state.editor = null; render(); return; }
    if (action === 'batch-import') { await batchImport(); return; }
    if (action === 'save-limit') {
      const input = document.getElementById('f-limit');
      const v = Math.max(0, Math.min(200, Number(input ? input.value : 20) || 0));
      state.settings = { ...state.settings, dailyNewLimit: v };
      await db.setMeta('settings', state.settings);
      rebuildQueue();
      render();
      toast('每日新词上限已设为 ' + v);
      return;
    }
    if (action === 'save-gap') {
      const input = document.getElementById('f-gap');
      const raw = Number(input ? input.value : 4);
      const v = Math.max(RELEARN_GAP_MIN, Math.min(RELEARN_GAP_MAX, Number.isFinite(raw) && raw ? raw : 4));
      state.settings = { ...state.settings, relearnGap: v };
      await db.setMeta('settings', state.settings);
      state.relearn.forEach((e) => { e.gap = Math.min(e.gap, v); });
      rebuildQueue();
      render();
      toast('已设为间隔 ' + v + ' 张');
      return;
    }
    if (action === 'export') { exportAll(); return; }
    if (action === 'import') { const f = document.getElementById('file'); if (f) f.click(); return; }
    if (action === 'reset') {
      if (!confirm('这会清空所有词条和复习进度，确定？')) return;
      await db.clearAll();
      state.relearn = [];
      await loadAll();
      await ensureDeck();
      await loadAll();
      rebuildQueue();
      render();
      toast('已重置');
      return;
    }
  });

  view.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'search') { state.search = e.target.value; renderLibrary(); const el = document.getElementById('search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    if (e.target && e.target.id === 'batch') state.batch = e.target.value;
  });

  view.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'file') { importAll(e.target.files && e.target.files[0]); }
  });
}

/* ---------- 键盘快捷键（电脑上用更快） ---------- */
document.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (state.route !== 'review') return;
  const k = e.key;
  if (k === '1') { e.preventDefault(); gradeCard(GRADES.AGAIN); return; }
  if (k === '2') { e.preventDefault(); gradeCard(GRADES.HARD); return; }
  if (k === '3') { e.preventDefault(); gradeCard(GRADES.GOOD); return; }
  if (k === ' ' || k === 'Enter') {
    e.preventDefault();
    if (state.lastGraded) { state.lastGraded = null; state.peekedId = null; render(); }
    return;
  }
  if (k === 'u' || k === 'z') { e.preventDefault(); undoLast(); return; }
  if (k === 'p') {
    e.preventDefault();
    const c = currentCard();
    if (c) { state.peekedId = state.peekedId === c.id ? null : c.id; render(); }
  }
});

/* ---------- 启动 ---------- */

(async function boot() {
  try {
    await db.openDB();
  } catch (err) {
    bootError('浏览器存储不可用（' + err.message + '）。请用 Safari/Chrome 打开，而不是文件管理器预览。');
    return;
  }
  try {
    await ensureDeck();
    await loadAll();
    rebuildQueue();
    render();
  } catch (err) {
    bootError('启动失败：' + err.message);
  }
  try { if (navigator.serviceWorker) navigator.serviceWorker.register('./sw.js').catch(() => {}); } catch (err) { /* 忽略 */ }
})();
