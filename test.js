'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('./shared.js');

// ---------- bitmap pack/unpack ----------

test('packBits/unpackBits round-trips a non-byte-aligned bool array', () => {
  const bits = [true, false, true, true, false, false, false, false, false, true]; // length 10
  const packed = T.packBits(bits);
  assert.strictEqual(typeof packed, 'string');
  assert.deepStrictEqual(T.unpackBits(packed, bits.length), bits);
});

test('packBits/unpackBits round-trips an all-false and all-true array', () => {
  const off = new Array(90).fill(false);
  const on = new Array(90).fill(true);
  assert.deepStrictEqual(T.unpackBits(T.packBits(off), 90), off);
  assert.deepStrictEqual(T.unpackBits(T.packBits(on), 90), on);
});

// ---------- trip token ----------

test('trip token round-trips name/start/days', () => {
  const trip = { name: 'Ski 2026', start: '2026-06-15', days: 90 };
  const token = T.encodeTripToken(trip);
  assert.deepStrictEqual(T.decodeTripToken(token), trip);
});

// ---------- friend code ----------

test('friend code round-trips trip, unicode name, and availability', () => {
  const token = T.encodeTripToken({ name: 'Café Trip ⛷️', start: '2026-06-15', days: 12 });
  const free = [true, false, true, false, false, true, true, false, false, false, true, false];
  const code = T.encodeFriendCode({ trip: token, name: 'Renée 😀', free });
  const out = T.decodeFriendCode(code);
  assert.strictEqual(out.trip, token);
  assert.strictEqual(out.name, 'Renée 😀');
  assert.deepStrictEqual(out.free, free);
});

// ---------- loadCodes (bulk paste + validation) ----------

function makeCode(token, name, free) {
  return T.encodeFriendCode({ trip: token, name, free });
}

test('loadCodes accepts multiple codes of the same trip, split on commas/newlines/spaces', () => {
  const token = T.encodeTripToken({ name: 'Trip', start: '2026-06-15', days: 5 });
  const a = makeCode(token, 'Alice', [true, true, false, false, false]);
  const b = makeCode(token, 'Bob', [false, true, true, false, false]);
  const blob = `${a},\n  ${b}\n`;
  const res = T.loadCodes(blob);
  assert.strictEqual(res.accepted.length, 2);
  assert.deepStrictEqual(res.accepted.map(p => p.name).sort(), ['Alice', 'Bob']);
  assert.strictEqual(res.rejected.length, 0);
  assert.deepStrictEqual(res.trip, { name: 'Trip', start: '2026-06-15', days: 5 });
});

test('loadCodes hard-rejects a code from a different trip with a reason', () => {
  const t1 = T.encodeTripToken({ name: 'Ski 2026', start: '2026-06-15', days: 5 });
  const t2 = T.encodeTripToken({ name: 'Tahoe Summer', start: '2026-07-01', days: 5 });
  const a = makeCode(t1, 'Alice', [true, true, false, false, false]);
  const stray = makeCode(t2, 'Bob', [true, true, false, false, false]);
  const res = T.loadCodes(`${a}\n${stray}`);
  assert.strictEqual(res.accepted.length, 1);
  assert.strictEqual(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /different trip/);
  assert.match(res.rejected[0].reason, /Tahoe Summer/);
});

test('loadCodes rejects unreadable garbage', () => {
  const token = T.encodeTripToken({ name: 'Trip', start: '2026-06-15', days: 5 });
  const a = makeCode(token, 'Alice', [true, false, false, false, false]);
  const res = T.loadCodes(`${a}\nnot-a-real-code!!!`);
  assert.strictEqual(res.accepted.length, 1);
  assert.strictEqual(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /unreadable|unparse|read/i);
});

test('loadCodes flags duplicate names (case-insensitive)', () => {
  const token = T.encodeTripToken({ name: 'Trip', start: '2026-06-15', days: 5 });
  const a = makeCode(token, 'Dave', [true, false, false, false, false]);
  const b = makeCode(token, 'dave', [false, true, false, false, false]);
  const res = T.loadCodes(`${a}\n${b}`);
  assert.strictEqual(res.accepted.length, 1);
  assert.strictEqual(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /duplicate/i);
});

// ---------- rankBlocks ----------

// Shared fixture: 7-day window, three staggered people.
const FX_DAYS = 7;
const FX = [
  { name: 'Alice', free: idx([0, 1, 2, 3, 4], FX_DAYS) },
  { name: 'Bob', free: idx([1, 2, 3, 4, 5], FX_DAYS) },
  { name: 'Carol', free: idx([2, 3, 4, 5, 6], FX_DAYS) },
];
function idx(ones, len) {
  const a = new Array(len).fill(false);
  ones.forEach(i => (a[i] = true));
  return a;
}

test('rankBlocks (strict, K=0) finds the all-three window and names the dropouts', () => {
  const w = T.rankBlocks(FX, FX_DAYS, 3, 0);
  const top = w.reduce((best, x) => (x.score > best.score ? x : best), w[0]);
  assert.strictEqual(top.d, 2);
  assert.strictEqual(top.score, 3);
  assert.deepStrictEqual(top.attendees, ['Alice', 'Bob', 'Carol']);

  const first = w.find(x => x.d === 0);
  assert.strictEqual(first.score, 1);
  assert.deepStrictEqual(first.attendees, ['Alice']);
  assert.deepStrictEqual(first.missing, ['Bob', 'Carol']);
});

test('rankBlocks (lenient, K=1) lets a one-day-short person still count', () => {
  // window d=1 covers days 1,2,3; Carol is free only 2,3 (misses day 1) -> counts at K=1
  const w = T.rankBlocks(FX, FX_DAYS, 3, 1);
  const d1 = w.find(x => x.d === 1);
  assert.strictEqual(d1.score, 3);
  assert.deepStrictEqual(d1.attendees, ['Alice', 'Bob', 'Carol']);
});

test('rankBlocks returns nothing when N exceeds the window', () => {
  assert.deepStrictEqual(T.rankBlocks(FX, FX_DAYS, 8, 0), []);
});

test('rankBlocks with an empty pool yields zero-score windows', () => {
  const w = T.rankBlocks([], FX_DAYS, 3, 0);
  assert.strictEqual(w.length, FX_DAYS - 3 + 1);
  assert.ok(w.every(x => x.score === 0 && x.attendees.length === 0));
});

// ---------- collapseStretches ----------

test('collapseStretches merges consecutive windows with the identical attendee set', () => {
  const windows = [
    { d: 1, N: 3, score: 3, attendees: ['Alice', 'Bob', 'Carol'], missing: [] },
    { d: 2, N: 3, score: 3, attendees: ['Alice', 'Bob', 'Carol'], missing: [] },
    { d: 3, N: 3, score: 3, attendees: ['Alice', 'Bob', 'Carol'], missing: [] },
  ];
  const merged = T.collapseStretches(windows);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].startD, 1);
  assert.strictEqual(merged[0].endD, 3);
  assert.strictEqual(merged[0].placements, 3);
  assert.strictEqual(merged[0].score, 3);
});

test('collapseStretches keeps consecutive windows with different sets separate', () => {
  const windows = [
    { d: 0, N: 3, score: 2, attendees: ['Alice', 'Bob'], missing: ['Carol'] },
    { d: 1, N: 3, score: 2, attendees: ['Alice', 'Bob'], missing: ['Carol'] },
    { d: 2, N: 3, score: 2, attendees: ['Alice', 'Carol'], missing: ['Bob'] },
  ];
  const merged = T.collapseStretches(windows);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].placements, 2);
  assert.strictEqual(merged[1].placements, 1);
});

test('collapseStretches sorts by score, then flexibility (placements), then earliest', () => {
  const windows = [
    { d: 0, N: 3, score: 2, attendees: ['Alice', 'Bob'], missing: ['Carol'] },
    { d: 5, N: 3, score: 3, attendees: ['Alice', 'Bob', 'Carol'], missing: [] },
    { d: 6, N: 3, score: 3, attendees: ['Alice', 'Bob', 'Carol'], missing: [] },
  ];
  const merged = T.collapseStretches(windows);
  assert.strictEqual(merged[0].score, 3);
  assert.strictEqual(merged[0].placements, 2);
  assert.strictEqual(merged[1].score, 2);
});

// ---------- analyze (rank + exclude + collapse) ----------

test('analyze excludes a named person and re-ranks the pool', () => {
  // Excluding Carol; with N=3,K=0 the best windows shift to Alice+Bob territory.
  const res = T.analyze(FX, FX_DAYS, { N: 3, K: 0, excluded: ['Carol'] });
  assert.ok(res.length >= 1);
  const top = res[0];
  assert.ok(!top.attendees.includes('Carol'));
  assert.ok(!top.missing.includes('Carol'));
  assert.strictEqual(top.score, 2); // Alice+Bob both free across days 1-3
  assert.deepStrictEqual(top.attendees, ['Alice', 'Bob']);
});

// ---------- addDays (absolute date math) ----------

test('addDays handles zero, month rollover, year rollover, and non-leap Feb', () => {
  assert.strictEqual(T.addDays('2026-06-15', 0), '2026-06-15');
  assert.strictEqual(T.addDays('2026-06-15', 30), '2026-07-15');
  assert.strictEqual(T.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(T.addDays('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
});
