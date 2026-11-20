/**
 * 走查演示：按回放阶段分段领取三个来源，组装承诺、提交证据、回查争议。
 * 用法：先 `npm start` 启动来源服务，再 `npm run audit`（或 SOURCE_URL=... node src/cli.mjs）。
 */
import { SourceClient } from './source-client.mjs';
import { EvidenceStore } from './evidence-store.mjs';

const base = process.env.SOURCE_URL ?? 'http://127.0.0.1:4100';
const client = new SourceClient(base, { limit: 2 });
const store = new EvidenceStore();

const fmtInterval = (iv) => (iv ? `[${iv[0]}, ${iv[1]}]` : '未落位');
const fmtProduct = (p) => (p ? `${p.merchant} ${p.sku}` : '未定');

function printPromise(view) {
  console.log(`  承诺 ${view.id}：状态 ${view.status}，商品 ${fmtProduct(view.product)}，口播区间 ${fmtInterval(view.speechInterval)}`);
  for (const f of view.fragments) {
    const att = f.attribution;
    const candidates = att.candidates.map((c) => `${c.card}(${c.merchant} ${c.sku} 重叠 ${fmtInterval(c.overlap)} rev${c.cardRevision})`);
    console.log(`    片段 ${f.key} [${f.record} rev${f.revision}] local ${fmtInterval(f.local)} -> broadcast ${fmtInterval(f.broadcast)}（${f.basis ?? '无映射'}）`);
    console.log(`      「${f.text}」`);
    if (att.status === 'determined') console.log(`      归属：明确标识 ${fmtProduct(att.product)}`);
    else if (att.candidates.length > 0) console.log(`      归属候选（全部保留）：${candidates.join('；')}`);
    else console.log(`      归属：${att.status === 'unplaced' ? '待时轴落位' : '无候选'}`);
    if (att.uncovered.length > 0) console.log(`      无卡覆盖区间：${att.uncovered.map(fmtInterval).join('、')}`);
  }
  for (const m of view.missing) console.log(`    缺失：${m.kind} ${m.note ?? ''} ${m.after ? `（断点 ${m.after.session} local ${m.after.local}）` : ''}`);
}

function printStage(stage, results) {
  console.log(`\n=== 回放阶段 ${stage} ===`);
  for (const [source, r] of Object.entries(results)) {
    console.log(`  领取 ${source}：新增 ${r.applied.length} 条（${r.applied.join(', ') || '无'}），重复跳过 ${r.skipped.length} 条`);
  }
  for (const view of store.promisesView()) printPromise(view);
  const leases = store.leasesView();
  if (leases.length > 0) {
    console.log('  片段领用：' + leases.map((l) => `${l.segment} <- ${l.checks.join('/')}`).join('；'));
  }
  const submittable = store.submittable();
  console.log(`  可提交清单：${submittable.length > 0 ? submittable.map((s) => s.id).join(', ') : '（空）'}`);
}

async function main() {
  let overview;
  try {
    overview = await client.overview();
  } catch {
    console.error(`连不上来源服务 ${base}，请先运行 npm start`);
    process.exitCode = 1;
    return;
  }
  console.log(`来源服务 ${base}，共 ${overview.stages} 个回放阶段，来源：${overview.sources.join(', ')}`);

  for (let stage = 1; stage <= overview.stages; stage += 1) {
    await client.advance(stage);
    const bundle = await client.pullAll(overview.sources);
    const results = store.ingestBundle(bundle);
    // 领取新出现片段的原件并留存摘要凭据（阶段内尚不可领的留待下一阶段重试）
    for (const name of store.artifactsPending()) {
      const cred = await client.artifact(name);
      if (cred) store.attachArtifact(name, cred);
    }
    printStage(stage, results);

    // 证据提交：检查员对完整承诺提交证据，并关联引用了其片段的检查项
    for (const item of store.submittable()) {
      if (store.submissions.some((s) => s.promise === item.id)) continue;
      const check = store.checksView().find((c) => c.status === 'open' && item.fragments.includes(`${c.session}/${c.cue}`));
      const pkg = store.submit(item.id, { check: check?.id ?? null });
      console.log(`  提交证据 ${pkg.id}（承诺 ${pkg.promise}，关联检查 ${check?.id ?? '无'}，保留至 ${new Date(pkg.retentionUntil).toISOString()}）`);
      console.log(`    版本绑定（以口播当时为准）：${pkg.terms.product.bindings.map((b) => `${b.edition}「${b.shipment}」覆盖 ${fmtInterval(b.covers)}`).join('；')}`);
    }
    // 回查争议
    for (const sub of store.submissionsView()) {
      for (const d of sub.disputes) {
        const affected = (d.affectedAttributions ?? []).map((a) => `${a.card}(${a.merchant}) ${a.change} ${fmtInterval(a.before)} -> ${fmtInterval(a.after)}`);
        const span = d.kind === 'speech-interval-changed' ? ` ${fmtInterval(d.before)} -> ${fmtInterval(d.after)}` : '';
        console.log(`  争议回查 ${sub.id}：${d.kind}${d.fragment ? ` 片段 ${d.fragment}` : ''}${span}${affected.length > 0 ? `，受影响归属：${affected.join('；')}` : ''}`);
      }
    }
    for (const c of store.checksView()) {
      if (c.affected.length > 0) console.log(`  检查项 ${c.id} 归属受影响 ${c.affected.length} 处（主张卡 ${c.claimedCard ?? '无'}，当前一致：${c.consistent}）`);
    }
  }

  console.log('\n=== 双向追查示例 ===');
  const trace = store.traceProduct('松桥铺', 'K11');
  console.log(`商品 松桥铺 K11：版本档 ${trace.terms.map((t) => `${t.edition}(${t.shipment}, valid ${fmtInterval(t.valid)}, ${t.record})`).join('；')}`);
  console.log(`  口播：${trace.captions.map((c) => `${c.key}[${c.record} rev${c.revision}, ${c.role}]`).join('；')}`);
  console.log(`  商品卡：${trace.cards.map((c) => `${c.card} rev${c.revision} ${fmtInterval(c.span)}（历史 ${c.history.length} 版）`).join('；')}`);
  console.log(`  争议 ${trace.disputes.length} 条；提交 ${trace.submissions.map((s) => s.id).join(', ') || '无'}`);
  const interval = store.traceInterval({ session: 'A37', local: [1000, 4300] });
  console.log(`区间追查 A37 local [1000, 4300] -> broadcast ${fmtInterval(interval.interval)}（${interval.basis}）：字幕 ${interval.captions.map((c) => c.key).join(', ') || '无'}；商品卡 ${interval.cards.map((c) => c.card).join(', ') || '无'}；争议 ${interval.disputes.length} 条`);

  console.log('\n=== 已提交片段凭据（保留期内） ===');
  for (const cred of store.queryCredentials()) {
    console.log(`  ${cred.id}（承诺 ${cred.promise}）：${cred.fragments.map((f) => `${f.record} rev${f.revision} ${f.session} broadcast ${fmtInterval(f.broadcast)} 摘要 ${f.artifact?.sha256?.slice(0, 12) ?? '无'}…`).join('；')}`);
  }
}

await main();
