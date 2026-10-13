// What is kept, what is asked for again and when (cache.js), with the clock
// in the test's hands: a feed that answers some requests with nothing, one
// symbol that never has data, the network not being up yet, and an outage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cached, forEachSymbol, INCOMPLETE, markIncomplete } from '../cache.js';

const HOUR_MS = 3600_000;
const symbols = Array.from({ length: 86 }, (_, i) => `S${i}`);
const count = (value) => Object.keys(value).length;
const settled = () => new Promise((resolve) => setImmediate(resolve));
// What a promise has resolved to by now, or 'waiting' if it has not.
const byNow = (promise) => Promise.race([promise, settled().then(() => 'waiting')]);

// Stops the clock at a fixed moment. `after` moves it on; `seconds` is how far
// it has come since the start.
function clock(t) {
  const start = Date.parse('2026-10-13T06:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  return { after: (seconds) => t.mock.timers.tick(seconds * 1000), seconds: () => (Date.now() - start) / 1000 };
}

test('a third of the answers are empty at first, then the feed recovers', async (t) => {
  const { after } = clock(t);
  let empty = new Set(symbols.slice(0, 30));
  let asked = [];
  const get = cached(HOUR_MS, (known) => forEachSymbol(async (symbol) => {
    asked.push(symbol);
    if (empty.has(symbol)) throw new Error('no bars');
    return [symbol, Date.now()];
  }, symbols, 8, known));

  await t.test('first load: empty answers are not taken for "no history"', async () => {
    const { value } = await get();
    // Each failure is tried twice: 86 requests and 30 more.
    assert.deepEqual([count(value), value[INCOMPLETE].length, asked.length], [56, 30, 116]);
  });
  await t.test('5 s later: served from cache, nothing asked', async () => {
    asked = []; after(5);
    const { value } = await get();
    assert.deepEqual([asked.length, count(value)], [0, 56]);
  });
  await t.test('20 s later: only the 30 missing are asked for', async () => {
    empty = new Set(symbols.slice(0, 4)); asked = []; after(16);
    const { value } = await get();
    assert.deepEqual([new Set(asked).size, count(value), value[INCOMPLETE].length], [30, 82, 4]);
  });
  await t.test('progress keeps the wait at 20 s; the last 4 arrive', async () => {
    empty = new Set(); asked = []; after(21);
    const { value } = await get();
    assert.deepEqual([asked.sort(), count(value), value[INCOMPLETE]], [['S0', 'S1', 'S2', 'S3'], 86, undefined]);
  });
  await t.test('once complete, nothing more until the cache time is up', async () => {
    asked = []; after(600);
    await get();
    assert.equal(asked.length, 0);
  });
  await t.test('after the cache time everything is loaded afresh', async () => {
    asked = []; after(3600);
    const { value, at } = await get();
    assert.deepEqual([new Set(asked).size, value.S85[1], at], [86, Date.now(), Date.now()]);
  });
});

test('one symbol never has data: it is not asked for endlessly', async (t) => {
  const { after, seconds } = clock(t);
  const tries = new Set();
  let others = 0;
  const get = cached(HOUR_MS, (known) => forEachSymbol(async (symbol) => {
    if (symbol !== 'S0') { others++; return [symbol]; }
    tries.add(seconds());
    throw new Error('no bars');
  }, symbols, 8, known));
  await get();
  others = 0;
  for (let i = 0; i < 360; i++) { after(10); await get(); } // a page polling every 10 s for an hour

  await t.test('a symbol with no data: each wait is twice the last', () => {
    // 20 s, 40 s, 80 s and so on, until the hourly reload asks for everything.
    assert.deepEqual([...tries], [0, 20, 60, 140, 300, 620, 1260, 2540, 3600]);
  });
  await t.test('...and the other 85 are left alone until the hourly reload', () => {
    assert.equal(others, 85);
  });
});

test('a full reload that fails for a symbol keeps what was known', async (t) => {
  const { after } = clock(t);
  let down = false;
  let label = 'first';
  const get = cached(HOUR_MS, (known) => forEachSymbol(async (symbol) => {
    if (down && symbol === 'S7') throw new Error('no bars');
    return [symbol, label];
  }, symbols, 8, known));
  await get();

  await t.test('hourly reload fails for one symbol: its old bars stay', async () => {
    down = true; label = 'reload'; after(3601);
    const { value } = await get();
    assert.deepEqual([value.S7[1], value.S8[1], [...value[INCOMPLETE]]], ['first', 'reload', ['S7']]);
  });
  await t.test('...and are replaced 20 s later, the rest untouched', async () => {
    down = false; label = 'top-up'; after(21);
    const { value } = await get();
    assert.deepEqual([value.S7[1], value.S8[1], value[INCOMPLETE]], ['top-up', 'reload', undefined]);
  });
});

test('nothing at all on the first load is reported as an error', async (t) => {
  clock(t);
  const get = cached(HOUR_MS, (known) => forEachSymbol(async () => { throw new Error('down'); }, symbols, 8, known));
  await assert.rejects(get(), { message: 'chart feed unavailable' });
});

test('everything fails for a while (the network cannot find the feed), then it all comes back', async (t) => {
  const { after, seconds } = clock(t);
  let down = true;
  const tries = [];
  const get = cached(HOUR_MS, async (known) => {
    tries.push(seconds());
    // As the history loaders do: an outage becomes an empty result that names
    // every symbol, with whatever the stand-in could supply.
    const loaded = await forEachSymbol(async (symbol) => {
      if (down) throw new Error('ENOTFOUND');
      return [symbol];
    }, symbols, 8, known).catch(() => null);
    return loaded ?? markIncomplete({ FRED: ['stand-in'] }, [...symbols], symbols.length);
  });
  await get();
  for (let i = 0; i < 18; i++) { after(10); await get(); } // three minutes of a page polling

  await t.test('an outage is retried every 20 s, with no growing wait', () => {
    assert.deepEqual(tries, [0, 20, 40, 60, 80, 100, 120, 140, 160, 180]);
  });
  await t.test('...and everything is there within 20 s of it ending', async () => {
    down = false; after(20);
    const { value } = await get();
    assert.deepEqual([count(value), value.FRED, value[INCOMPLETE]], [87, ['stand-in'], undefined]);
  });
});

// The 07:30 job can start the server before the network is up after the Mac wakes.
test('the first requests fail, later ones succeed', async (t) => {
  const { after } = clock(t);
  let networkUp = false;
  let asked = 0;
  const get = cached(HOUR_MS, (known) => forEachSymbol(async (symbol) => {
    asked++;
    if (!networkUp && Number(symbol.slice(1)) < 29) throw new Error('network down');
    return [symbol];
  }, symbols, 8, known));

  await t.test('first load: what did answer is served, and marked incomplete', async () => {
    const { value } = await get();
    assert.deepEqual([count(value), value[INCOMPLETE].length], [57, 29]);
  });
  await t.test('immediately after: served from cache', async () => {
    asked = 0;
    assert.equal(count((await get()).value), 57);
    assert.equal(asked, 0);
  });
  await t.test('20 seconds later: the missing ones are in, not kept back for the usual cache time', async () => {
    networkUp = true; after(21);
    const { value } = await get();
    assert.deepEqual([count(value), value[INCOMPLETE], asked], [86, undefined, 29]);
  });
  await t.test('a minute later: from cache, and the full cache time applies again', async () => {
    asked = 0; after(60);
    assert.equal(count((await get()).value), 86);
    assert.equal(asked, 0);
  });
});

test('a slow source: after 2.5 seconds the previous value is served while the refresh finishes', async (t) => {
  const { after } = clock(t);
  let loads = 0;
  let finish;
  const get = cached(10_000, () => {
    loads++;
    return loads === 1 ? Promise.resolve({ price: 1 }) : new Promise((resolve) => { finish = () => resolve({ price: 2 }); });
  });
  const first = await get();
  assert.deepEqual(first, { value: { price: 1 }, at: Date.now(), error: null });

  after(10); // the cache time is up
  const [one, another] = [get(), get()];
  after(2.4);
  assert.deepEqual([await byNow(one), await byNow(another)], ['waiting', 'waiting']);
  after(0.1);
  assert.deepEqual([await byNow(one), await byNow(another)], [first, first]);
  assert.equal(loads, 2); // both callers waited on the same refresh

  finish();
  await settled();
  assert.deepEqual(await get(), { value: { price: 2 }, at: Date.now(), error: null });
  assert.equal(loads, 2);
});

test('a source that fails: the last good value is served with the error, and it is asked again', async (t) => {
  const { after } = clock(t);
  let answer = () => ({ price: 1 });
  const get = cached(10_000, async () => answer());
  const { at } = await get();

  after(10);
  answer = () => { throw new Error('quote feed responded 503'); };
  assert.deepEqual(await get(), { value: { price: 1 }, at, error: 'quote feed responded 503' });

  after(1);
  answer = () => ({ price: 2 });
  assert.deepEqual(await get(), { value: { price: 2 }, at: Date.now(), error: null });
});

test('a source that fails before it has ever answered: there is nothing to serve', async (t) => {
  clock(t);
  const get = cached(10_000, async () => { throw new Error('quote feed returned no data'); });
  await assert.rejects(get(), { message: 'quote feed returned no data' });
});

test('loading symbol by symbol', async (t) => {
  await t.test('a symbol that fails gets one more try', async () => {
    const seen = new Set();
    const results = await forEachSymbol(async (symbol) => {
      if (symbol === 'B' && !seen.has(symbol)) { seen.add(symbol); throw new Error('dropped'); }
      return symbol.toLowerCase();
    }, ['A', 'B', 'C'], 2);
    assert.deepEqual([results, results[INCOMPLETE]], [{ A: 'a', B: 'b', C: 'c' }, undefined]);
  });
  await t.test('an answer of nothing leaves the symbol out without naming it as missing', async () => {
    const results = await forEachSymbol(async (symbol) => (symbol === 'B' ? null : symbol), ['A', 'B', 'C'], 2);
    assert.deepEqual([results, results[INCOMPLETE]], [{ A: 'A', C: 'C' }, undefined]);
  });
  await t.test('no more than `concurrency` are loaded at a time', async () => {
    let running = 0;
    let most = 0;
    await forEachSymbol(async (symbol) => {
      most = Math.max(most, ++running);
      await settled();
      running--;
      return symbol;
    }, symbols, 8);
    assert.equal(most, 8);
  });
  await t.test('everything missing is an outage; some of it missing is not', async () => {
    const known = markIncomplete({ A: 'a' }, ['B', 'C']);
    const some = await forEachSymbol(async (symbol) => { if (symbol === 'C') throw new Error('no bars'); return symbol; }, ['A', 'B', 'C'], 2, known);
    assert.deepEqual([some, [...some[INCOMPLETE]], some[INCOMPLETE].outage], [{ B: 'B' }, ['C'], false]);
    const none = await forEachSymbol(async () => { throw new Error('ENOTFOUND'); }, ['A', 'B', 'C'], 2, markIncomplete({}, ['A', 'B', 'C']));
    assert.deepEqual([none, none[INCOMPLETE].length, none[INCOMPLETE].outage], [{}, 3, true]);
  });
});
