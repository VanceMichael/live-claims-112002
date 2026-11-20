import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { SourceClient } from './src/source-client.mjs';
import { EvidenceStore } from './src/evidence-store.mjs';

const fixture = async (name) => JSON.parse(await readFile(new URL(`source-data/${name}.json`, import.meta.url), 'utf8'));

const close = (server) => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

async function setup(t) {
  const { server, url } = await start();
  t.after(() => close(server));
  return { server, client: new SourceClient(url, { limit: 2 }), url };
}

/** 把来源推进到指定阶段并领取全部来源，返回入库结果。 */
async function pullStage(client, store, stage) {
  await client.advance(stage);
  const { sources } = await client.overview();
  const bundle = await client.pullAll(sources);
  return store.ingestBundle(bundle);
}

test('分段领取：分页走查、按到达顺序、重复领取幂等', async (t) => {
  const { client } = await setup(t);
  const replayAll = await fixture('replay');
  await client.advance(4);
  // limit=2 时 6 条回放记录分 3 页领取，顺序与到达一致
  const pages = [];
  for await (const page of client.pages('replay')) pages.push(page.records.map((r) => r.record));
  assert.deepEqual(pages.flat(), replayAll.map((r) => r.record));
  assert.equal(pages.length, 3);

  const store = new EvidenceStore();
  const bundle = await client.pullAll(['replay', 'control', 'listings']);
  const first = store.ingestBundle(bundle);
  assert.equal(first.replay.applied.length, 6);
  const again = store.ingestBundle(bundle);
  assert.equal(again.replay.applied.length, 0);
  assert.equal(again.replay.skipped.length, 6);
  assert.equal(store.ingestLog.length, 6 + 4 + 3);
});

test('跨重连承诺：分段领取、时轴拼接、归属候选、提交与回查', async (t) => {
  const { client } = await setup(t);
  const index = await fixture('index');
  let clock = 1_000_000;
  const store = new EvidenceStore({ retentionMs: 1000, now: () => clock });

  // ---- 阶段 1：只领到前半句 ----
  let results = await pullStage(client, store, 1);
  assert.deepEqual(results.replay.applied, ['replay-1', 'replay-6']);
  let promise = store.promiseView('CLAIM8');
  assert.equal(promise.status, 'partial');
  assert.deepEqual(promise.product, {
    merchant: '松桥铺', sku: 'K11', basis: 'caption-explicit', record: 'replay-6', fragment: 'A36/CAP6',
  });
  // 缺失区间：口播在会话末端被切断，后续尚未领得
  assert.equal(promise.missing.length, 1);
  assert.equal(promise.missing[0].kind, 'continuation-pending');
  assert.deepEqual(promise.missing[0].after, { session: 'A36', local: 13000, broadcast: 13000 });
  // 基准会话：local 即 broadcast
  assert.deepEqual(promise.fragments[0].broadcast, [11200, 13000]);
  assert.equal(promise.fragments[0].basis, 'baseline');
  // 不完整承诺不在可提交清单，也不能提交
  assert.deepEqual(store.submittable(), []);
  assert.throws(() => store.submit('CLAIM8'), /尚未收全/);
  // 原件 v1 可领且摘要一致；v2 此阶段不可领
  const v1 = await client.artifact('v1.webm');
  assert.equal(v1.sha256, index.digests['v1.webm']);
  store.attachArtifact('v1.webm', v1);
  assert.equal(await client.artifact('v2.webm'), null);

  // ---- 阶段 2：后半句到达，但重连会话缺平台映射 ----
  results = await pullStage(client, store, 2);
  assert.deepEqual(results.replay.applied, ['replay-2', 'replay-3']);
  promise = store.promiseView('CLAIM8');
  assert.equal(promise.status, 'partial');
  assert.equal(promise.fragments.length, 2);
  const cap8early = promise.fragments.find((f) => f.key === 'A37/CAP8');
  assert.equal(cap8early.broadcast, null); // 时码从零重计，无映射不能拼回
  assert.deepEqual(promise.missing.map((m) => m.kind), ['session-unmapped']);
  assert.equal(promise.missing[0].session, 'A37');
  const unplaced = store.traceInterval({ session: 'A37', local: [1200, 3900] });
  assert.equal(unplaced.placed, false);
  const v2 = await client.artifact('v2.webm');
  assert.equal(v2.sha256, index.digests['v2.webm']);
  store.attachArtifact('v2.webm', v2);

  // ---- 阶段 3：平台映射到达，承诺收全；检查项领用片段 ----
  results = await pullStage(client, store, 3);
  assert.deepEqual(results.replay.applied, ['replay-4']);
  assert.deepEqual(results.control.applied, ['control-4']);
  promise = store.promiseView('CLAIM8');
  assert.equal(promise.status, 'complete');
  const cap8 = promise.fragments.find((f) => f.key === 'A37/CAP8');
  assert.deepEqual(cap8.broadcast, [14200, 16900]); // local [1200,3900] + offset 13000
  assert.equal(cap8.basis, 'clock');
  // 商品卡重叠：两个候选都保留，不取第一个
  assert.deepEqual(
    cap8.attribution.candidates.map((c) => ({ card: c.card, merchant: c.merchant, overlap: c.overlap })),
    [
      { card: 'KD1', merchant: '松桥铺', overlap: [14200, 15000] },
      { card: 'KD2', merchant: '溪岸铺', overlap: [14200, 16900] },
    ],
  );
  assert.deepEqual(cap8.attribution.uncovered, []);
  assert.deepEqual(store.submittable().map((s) => s.id), ['CLAIM8']);
  // 检查项 E81 由场控 read 记录录入，主张卡 KD1 与候选一致
  const e81 = store.checksView().find((c) => c.id === 'E81');
  assert.equal(e81.status, 'open');
  assert.equal(e81.segment, 'A37/V1');
  assert.equal(e81.consistent, true);
  // 同一段视频可被多个检查项引用；单个结束不影响其他
  store.registerCheck({ check: 'E82', session: 'A37', cue: 'CAP8', card: 'KD2' });
  store.registerCheck({ check: 'E83', session: 'A37', cue: 'CAP8' });
  assert.deepEqual(store.leasesView()[0].checks, ['E81', 'E82', 'E83']);
  store.closeCheck('E82');
  assert.deepEqual(store.leasesView()[0].checks, ['E81', 'E83']);
  store.closeCheck('E83');
  assert.deepEqual(store.leasesView()[0].checks, ['E81']);
  // 提交证据：快照冻结片段凭据与口播当时的版本绑定
  const pkg = store.submit('CLAIM8', { check: 'E81' });
  assert.equal(pkg.id, 'SUB-1');
  assert.equal(pkg.retentionUntil, clock + 1000);
  assert.deepEqual(
    pkg.fragments.map((f) => ({ record: f.record, revision: f.revision, broadcast: f.broadcast, basis: f.basis })),
    [
      { record: 'replay-6', revision: 1, broadcast: [11200, 13000], basis: 'baseline' },
      { record: 'replay-3', revision: 1, broadcast: [14200, 16900], basis: 'clock' },
    ],
  );
  assert.equal(pkg.fragments[0].artifact.sha256, index.digests['v1.webm']);
  assert.equal(pkg.fragments[1].artifact.sha256, index.digests['v2.webm']);
  assert.deepEqual(pkg.terms.product.bindings.map((b) => [b.edition, b.covers]), [['MX1', [11200, 16900]]]);
  const xiian = pkg.terms.candidates.find((c) => c.merchant === '溪岸铺');
  assert.deepEqual(xiian.bindings.map((b) => b.edition), ['MX2']);

  // ---- 阶段 4：字幕修订 + 场控补发切卡 + 新商户版本 ----
  results = await pullStage(client, store, 4);
  assert.deepEqual(results.replay.applied, ['replay-5']);
  assert.deepEqual(results.control.applied, ['control-3']);
  assert.deepEqual(results.listings.applied, ['listings-3']);
  promise = store.promiseView('CLAIM8');
  const cap8v2 = promise.fragments.find((f) => f.key === 'A37/CAP8');
  assert.equal(cap8v2.revision, 2);
  assert.deepEqual(cap8v2.broadcast, [14000, 17300]);
  // 修订后候选仍全部保留，空档如实标出
  assert.deepEqual(
    cap8v2.attribution.candidates.map((c) => [c.card, c.overlap, c.cardRevision]),
    [['KD1', [14000, 15000], 1], ['KD2', [16200, 17300], 2]],
  );
  assert.deepEqual(cap8v2.attribution.uncovered, [[15000, 16200]]);
  // 已提交证据可回查：标明哪些归属受影响
  const sub = store.submissionsView()[0];
  const factDispute = sub.disputes.find((d) => d.kind === 'fragment-facts-changed' && d.fragment === 'A37/CAP8');
  assert.ok(factDispute, '应标出片段事实变化');
  const kd2 = factDispute.affectedAttributions.find((a) => a.card === 'KD2');
  assert.equal(kd2.change, 'window-revised');
  assert.deepEqual(kd2.cardRevision, [1, 2]);
  assert.deepEqual(kd2.after, [16200, 17300]);
  assert.ok(sub.disputes.some((d) => d.kind === 'speech-interval-changed'));
  // 商户新版本 MX3 不适用口播当时区间，不生成另一条解释
  assert.ok(!sub.disputes.some((d) => d.kind === 'terms-context-changed'));
  assert.deepEqual(sub.terms.product.bindings.map((b) => [b.edition, b.covers]), [['MX1', [11200, 16900]]]);
  const nowBound = store.bindTerms('松桥铺', 'K11', [14000, 17300]);
  assert.deepEqual(nowBound.bindings.map((b) => b.edition), ['MX1']);
  assert.deepEqual(store.bindTerms('松桥铺', 'K11', [18000, 35000]).bindings.map((b) => b.edition), ['MX3']);
  // 检查项 E81 的归属受影响被标记
  const e81after = store.checksView().find((c) => c.id === 'E81');
  assert.equal(e81after.affected.length, 1);
  assert.ok(e81after.affected[0].affectedAttributions.some((a) => a.card === 'KD2'));
  assert.equal(e81after.consistent, true);
  // 迟到旧版字幕留痕但不回退
  store.ingest('replay', [{
    record: 'replay-99', availableFrom: 4, kind: 'caption',
    payload: { session: 'A37', part: 'V1', cue: 'CAP8', local: [0, 100], text: '旧版转写', revision: 1 },
  }]);
  assert.equal(store.promiseView('CLAIM8').fragments.find((f) => f.key === 'A37/CAP8').revision, 2);
  // 重复领取同一阶段幂等，不新增争议
  const disputesBefore = store.submissionsView()[0].disputes.length;
  const again = await pullStage(client, store, 4);
  assert.equal(again.replay.applied.length, 0);
  assert.equal(store.submissionsView()[0].disputes.length, disputesBefore);

  // ---- 保留期凭据查询：只含已提交片段 ----
  assert.equal(store.queryCredentials({ asOf: clock }).length, 1);
  assert.equal(store.queryCredentials({ asOf: clock + 1000 }).length, 1);
  assert.equal(store.queryCredentials({ asOf: clock + 1001 }).length, 0);
  const cred = store.queryCredentials({ asOf: clock })[0];
  assert.deepEqual(cred.fragments.map((f) => [f.record, f.revision]), [['replay-6', 1], ['replay-3', 1]]);
  assert.ok(cred.fragments.every((f) => f.artifact && f.artifact.state === 'fetched'));

  // ---- 双向追查 ----
  const byProduct = store.traceProduct('松桥铺', 'K11');
  assert.deepEqual(byProduct.captions.map((c) => [c.key, c.role]), [['A36/CAP6', 'explicit'], ['A37/CAP8', 'candidate']]);
  assert.deepEqual(byProduct.terms.map((t) => [t.edition, t.record]), [['MX1', 'listings-1'], ['MX3', 'listings-3']]);
  assert.deepEqual(byProduct.cards.map((c) => c.card), ['KD1']);
  assert.deepEqual(byProduct.promises.map((p) => p.id), ['CLAIM8']);
  assert.deepEqual(byProduct.submissions.map((s) => s.id), ['SUB-1']);
  assert.ok(byProduct.disputes.length >= 1);
  const byProduct2 = store.traceProduct('溪岸铺', 'K11');
  assert.equal(byProduct2.cards[0].card, 'KD2');
  assert.deepEqual(byProduct2.cards[0].history, [{ record: 'control-2', revision: 1, span: [14000, 18500] }]);
  // 从口播区间反查：空档区间无卡在架
  const gap = store.traceInterval({ broadcast: [15000, 16200] });
  assert.deepEqual(gap.captions.map((c) => c.key), ['A37/CAP8']);
  assert.deepEqual(gap.cards, []);
  const byInterval = store.traceInterval({ session: 'A37', local: [1000, 4300] });
  assert.equal(byInterval.placed, true);
  assert.deepEqual(byInterval.interval, [14000, 17300]);
  assert.deepEqual(byInterval.cards.map((c) => c.card), ['KD1', 'KD2']);
  assert.ok(byInterval.disputes.length >= 1);
});

test('重新开播形成独立会话：各场时轴互不混用', async (t) => {
  const { client } = await setup(t);
  await client.advance(1);
  const store = new EvidenceStore();
  store.ingestBundle({
    replay: [
      { record: 'r1', availableFrom: 1, kind: 'video', payload: { broadcast: 'L1', session: 'S1', part: 'V1', span: [0, 5000] } },
      { record: 'r2', availableFrom: 1, kind: 'video', payload: { broadcast: 'L2', session: 'S9', part: 'V1', span: [0, 8000] } },
      { record: 'r3', availableFrom: 1, kind: 'caption', payload: { session: 'S9', part: 'V1', cue: 'C1', local: [100, 900], text: '另一场的口播', revision: 1 } },
    ],
    control: [],
    listings: [],
  });
  // L2 的首个会话是自己的基准会话，与 L1 无关
  const interval = store.traceInterval({ session: 'S9', local: [100, 900] });
  assert.equal(interval.placed, true);
  assert.equal(interval.basis, 'baseline');
  assert.deepEqual(interval.interval, [100, 900]);
  // 未映射的重连会话不能拼回
  store.ingest('replay', [{ record: 'r4', availableFrom: 1, kind: 'video', payload: { broadcast: 'L1', session: 'S2', part: 'V1', span: [0, 5000] } }]);
  assert.equal(store.placementFor('S2'), null);
  store.ingest('replay', [{ record: 'r5', availableFrom: 1, kind: 'clock', payload: { broadcast: 'L1', session: 'S2', offset: 5000 } }]);
  assert.deepEqual(store.placementFor('S2'), { offset: 5000, basis: 'clock', record: 'r5' });
});
