/**
 * 直播口播承诺取证核心。
 *
 * 时轴约定：
 * - 每场 broadcast 的首个会话为基准会话，其 local 时码即 broadcast 时码（offset 0）。
 * - 中断重连产生的新会话时码从零重计，只有平台 clock 记录给出 offset 后才能拼回时轴；
 *   无映射时片段保持会话内相对时码，不与别会话混排。
 * - 频道重新开播形成新的 broadcast，各场会话互不混用。
 *
 * 归属约定：
 * - 字幕自带商户与 SKU 时为明确归属（caption-explicit）。
 * - 否则按口播播出区间与商品卡窗口的重叠收集候选；商品卡允许重叠，
 *   边界不清时保留全部候选，不取第一个充数。
 * - 主播可能在商品卡撤下后继续口播，无卡覆盖的区间记为 uncovered，不强行归属。
 *
 * 承诺约定：
 * - 同一 continuation 标识的字幕片段组成一项承诺，可跨重连点。
 * - 全部片段都能按原时码纽带（基准会话或平台映射）证明、且商品已确定时才算完整承诺。
 * - 只领到前半句时标记已确定商品与缺失区间，不进入可提交清单。
 *
 * 版本约定：
 * - 商户公告成分按口播当时的播出时码绑定版本档；后续领到的新版本
 *   不会改写已提交的解释，只在其适用区间与口播区间相交时标出争议待复核。
 */

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const captionKey = (session, cue) => `${session}/${cue}`;
const segmentKey = (session, part) => `${session}/${part}`;
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 从区间 [a, b] 中扣除若干覆盖段，返回未覆盖的空档。 */
export function subtractInterval([a, b], covers) {
  const sorted = covers.filter((c) => c[1] > a && c[0] < b).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const gaps = [];
  let cursor = a;
  for (const [s, e] of sorted) {
    if (e <= cursor) continue;
    if (s > cursor) gaps.push([cursor, Math.min(s, b)]);
    cursor = Math.max(cursor, e);
    if (cursor >= b) return gaps;
  }
  if (cursor < b) gaps.push([cursor, b]);
  return gaps;
}

/** 比对前后候选列表，列出受影响的归属（窗口修订 / 新增 / 移除）。 */
export function affectedAttributions(before = [], after = []) {
  const beforeMap = new Map(before.map((c) => [c.card, c]));
  const afterMap = new Map(after.map((c) => [c.card, c]));
  const affected = [];
  for (const [card, b] of beforeMap) {
    const a = afterMap.get(card);
    if (!a) {
      affected.push({ card, merchant: b.merchant, sku: b.sku, change: 'removed', before: b.overlap });
    } else if (!sameJson(a.overlap, b.overlap) || a.cardRevision !== b.cardRevision) {
      affected.push({
        card, merchant: a.merchant, sku: a.sku, change: 'window-revised',
        before: b.overlap, after: a.overlap, cardRevision: [b.cardRevision, a.cardRevision],
      });
    }
  }
  for (const [card, a] of afterMap) {
    if (!beforeMap.has(card)) affected.push({ card, merchant: a.merchant, sku: a.sku, change: 'added', after: a.overlap });
  }
  return affected;
}

/** 比对单个字幕片段的前后事实，有变化时返回变化明细，否则返回 null。 */
function diffFacts(before, after) {
  const changes = {};
  if (before.revision !== after.revision) changes.revision = { before: before.revision, after: after.revision };
  if (!sameJson(before.broadcast, after.broadcast)) changes.broadcast = { before: before.broadcast, after: after.broadcast };
  if (!sameJson(before.candidates, after.candidates)) changes.candidates = { before: before.candidates, after: after.candidates };
  if (!sameJson(before.uncovered, after.uncovered)) changes.uncovered = { before: before.uncovered, after: after.uncovered };
  return Object.keys(changes).length > 0 ? changes : null;
}

/** 提取版本绑定的版本档签名（只含版本身份，不含覆盖区间），用于识别“解释是否被改写”。 */
function editionsSignature(terms) {
  const list = [];
  if (terms.product) {
    for (const b of terms.product.bindings) list.push(`${terms.product.merchant}/${terms.product.sku}/${b.edition}/${b.record}`);
  }
  for (const c of terms.candidates) {
    for (const b of c.bindings) list.push(`${c.merchant}/${c.sku}/${b.edition}/${b.record}`);
  }
  return list.sort();
}

export class EvidenceStore {
  #applying = 0; // 正在应用一批来源记录：期间不初始化检查基线，待本轮重算统一处理

  constructor({ retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now() } = {}) {
    this.retentionMs = retentionMs;
    this.now = now;
    this.seen = new Set();        // `${source}:${record}` 已领取记录，保证重复领取幂等
    this.broadcasts = new Map();  // broadcast -> { baseline, record }
    this.sessions = new Map();    // session -> { broadcast, parts: Map(part -> video) }
    this.clocks = new Map();      // session -> { offset, record }
    this.captions = new Map();    // session/cue -> { current, history, stale }
    this.cards = new Map();       // card -> { current, history, stale }
    this.terms = [];              // 公告成分版本档，按到达追加，撤回后历史档仍可查
    this.checks = new Map();      // check -> 检查项
    this.leases = new Map();      // session/part -> Set(checkId) 片段领用计数
    this.artifacts = new Map();   // 原件名 -> { sha256, bytes }
    this.submissions = [];        // 已提交证据包（冻结快照 + 争议）
    this.ingestLog = [];          // 领取日志，供追查来源
    this.derived = null;          // 最近一次推算结果
  }

  // ---------------------------------------------------------------- 领取与修订

  /**
   * 领取一批来源记录并应用修订。重复领取同一条记录幂等跳过。
   * 返回 { applied, skipped }（来源记录键）。
   */
  ingest(source, records) {
    this.#applying += 1;
    let result;
    try {
      result = this.#ingestApply(source, records);
    } finally {
      this.#applying -= 1;
    }
    if (result.applied.length > 0) this.#recompute();
    return result;
  }

  /**
   * 一轮领取多个来源（如一个回放阶段的全部来源），只重算一次，
   * 已提交证据与检查项按这一轮到达后的整体状态回查。
   */
  ingestBundle(bundle) {
    this.#applying += 1;
    const results = {};
    let changed = false;
    try {
      for (const [source, records] of Object.entries(bundle)) {
        results[source] = this.#ingestApply(source, records);
        if (results[source].applied.length > 0) changed = true;
      }
    } finally {
      this.#applying -= 1;
    }
    if (changed) this.#recompute();
    return results;
  }

  #ingestApply(source, records) {
    const applied = [];
    const skipped = [];
    for (const entry of records) {
      const id = `${source}:${entry.record}`;
      if (this.seen.has(id)) {
        skipped.push(entry.record);
        continue;
      }
      this.seen.add(id);
      this.ingestLog.push({ seq: this.ingestLog.length + 1, source, record: entry.record, kind: entry.kind, availableFrom: entry.availableFrom });
      this.#applyRecord(source, entry);
      applied.push(entry.record);
    }
    return { applied, skipped };
  }

  #applyRecord(source, entry) {
    const p = entry.payload;
    if (source === 'replay') {
      if (entry.kind === 'video') this.#applyVideo(entry);
      else if (entry.kind === 'caption') this.#applyCaption(entry);
      else if (entry.kind === 'clock') this.#applyClock(entry);
    } else if (source === 'control') {
      if (entry.kind === 'card') this.#applyCard(entry);
      else if (entry.kind === 'read') this.#applyRead(entry);
    } else if (source === 'listings') {
      if (entry.kind === 'terms') this.#applyTerms(entry);
    }
  }

  #applyVideo(entry) {
    const p = entry.payload;
    if (!this.broadcasts.has(p.broadcast)) {
      // 每场首个会话为基准会话：local 时码即 broadcast 时码
      this.broadcasts.set(p.broadcast, { baseline: p.session, record: entry.record });
    }
    if (!this.sessions.has(p.session)) this.sessions.set(p.session, { broadcast: p.broadcast, parts: new Map() });
    this.sessions.get(p.session).parts.set(p.part, {
      broadcast: p.broadcast, span: p.span, artifact: p.artifact ?? null, record: entry.record,
    });
  }

  #applyClock(entry) {
    const p = entry.payload;
    // 平台给出的会话 → broadcast 映射，是拼回同一时轴的唯一依据
    this.clocks.set(p.session, { offset: p.offset, record: entry.record, broadcast: p.broadcast });
  }

  #applyCaption(entry) {
    const p = entry.payload;
    const key = captionKey(p.session, p.cue);
    const record = { ...p, record: entry.record, source: 'replay', revision: p.revision ?? 1 };
    const slot = this.captions.get(key);
    if (!slot) {
      this.captions.set(key, { current: record, history: [], stale: [] });
    } else if (record.revision > slot.current.revision) {
      slot.history.push(slot.current);
      slot.current = record;
    } else {
      slot.stale.push(record); // 迟到旧版：留痕但不回退
    }
    // 唤醒等待该字幕区间的检查租约
    for (const check of this.checks.values()) {
      if (check.pendingLease && check.session === p.session && check.cue === p.cue) this.#attachLease(check);
    }
  }

  #applyCard(entry) {
    const p = entry.payload;
    const record = { ...p, record: entry.record, source: 'control', revision: p.revision ?? 1 };
    const slot = this.cards.get(p.card);
    if (!slot) {
      this.cards.set(p.card, { current: record, history: [], stale: [] });
    } else if (record.revision > slot.current.revision) {
      // revision 只更新同 card：补发的切卡时点替换现行窗口
      slot.history.push(slot.current);
      slot.current = record;
    } else {
      slot.stale.push(record);
    }
  }

  #applyTerms(entry) {
    const p = entry.payload;
    // 版本档按到达追加；撤回后历史档仍按明示 valid 时段可查
    this.terms.push({ ...p, record: entry.record, source: 'listings' });
  }

  #applyRead(entry) {
    const p = entry.payload;
    this.registerCheck({
      check: p.check, session: p.session, cue: p.cue, card: p.card ?? null,
      record: entry.record, revision: p.revision ?? 1,
    });
  }

  // ---------------------------------------------------------------- 时轴

  /**
   * 会话的时码纽带：基准会话 offset 0；重连会话须凭平台 clock 记录。
   * 无映射返回 null，表示该会话片段暂未确认与 broadcast 的关联。
   */
  placementFor(session) {
    const s = this.sessions.get(session);
    if (!s) return null;
    const b = this.broadcasts.get(s.broadcast);
    if (b && b.baseline === session) return { offset: 0, basis: 'baseline', record: b.record };
    const clock = this.clocks.get(session);
    if (clock) return { offset: clock.offset, basis: 'clock', record: clock.record };
    return null;
  }

  // ---------------------------------------------------------------- 归属

  /** 单条字幕的归属推算：明确标识优先，否则收集商品卡重叠候选并保留空档。 */
  attributeCaption(cap, placement) {
    const explicit = Boolean(cap.merchant && cap.sku);
    const result = {
      explicit,
      product: explicit ? { merchant: cap.merchant, sku: cap.sku } : null,
      candidates: [],
      uncovered: [],
      basis: explicit ? 'caption-explicit' : 'none',
      status: 'unplaced',
    };
    if (!placement) return result;
    const interval = [cap.local[0] + placement.offset, cap.local[1] + placement.offset];
    const broadcast = this.sessions.get(cap.session)?.broadcast;
    const covers = [];
    for (const slot of this.cards.values()) {
      const card = slot.current;
      if (card.broadcast !== broadcast) continue;
      if (cap.sku && card.sku !== cap.sku) continue; // 字幕给出 SKU 时按 SKU 过滤候选
      const s = Math.max(interval[0], card.span[0]);
      const e = Math.min(interval[1], card.span[1]);
      if (s < e) {
        result.candidates.push({
          card: card.card, merchant: card.merchant, sku: card.sku,
          overlap: [s, e], cardRevision: card.revision, record: card.record,
        });
        covers.push([s, e]);
      }
    }
    result.candidates.sort((x, y) => x.overlap[0] - y.overlap[0] || x.card.localeCompare(y.card));
    result.uncovered = subtractInterval(interval, covers);
    if (explicit) {
      result.status = 'determined';
    } else if (result.candidates.length > 0) {
      result.status = 'candidates';
      result.basis = 'card-overlap';
    } else {
      result.status = 'unattributed';
    }
    return result;
  }

  // ---------------------------------------------------------------- 承诺组装

  #buildPromises(placements, attributions) {
    const groups = new Map();
    for (const [key, slot] of this.captions) {
      const cont = slot.current.continuation;
      if (!cont) continue;
      if (!groups.has(cont)) groups.set(cont, []);
      groups.get(cont).push(key);
    }
    const promises = new Map();
    for (const [id, keys] of groups) {
      const fragments = keys.map((key) => {
        const cap = this.captions.get(key).current;
        const placement = placements.get(key);
        const video = this.sessions.get(cap.session)?.parts.get(cap.part);
        // 口播一直讲到会话视频末端：被断连切断，后续区间待领
        const cut = video ? cap.local[1] >= video.span[1] : false;
        return { key, caption: cap, placement, cut, attribution: attributions.get(key) };
      });
      fragments.sort((x, y) => {
        const xa = x.placement ? x.placement.interval[0] : Number.MAX_SAFE_INTEGER;
        const ya = y.placement ? y.placement.interval[0] : Number.MAX_SAFE_INTEGER;
        return xa - ya || x.key.localeCompare(y.key);
      });
      const sessions = new Set(fragments.map((f) => f.caption.session));
      const missing = [];
      for (const f of fragments) {
        if (!f.placement) {
          missing.push({ kind: 'session-unmapped', fragment: f.key, session: f.caption.session, note: '平台尚未给出时码映射，片段未拼回时轴' });
          continue;
        }
        if (!f.attribution.explicit && f.attribution.candidates.length === 0) {
          missing.push({ kind: 'unattributed', fragment: f.key, note: '口播区间内没有重叠的商品卡，尚未归属' });
        }
        if (f.cut && !fragments.some((g) => g !== f && g.caption.session !== f.caption.session)) {
          missing.push({
            kind: 'continuation-pending', fragment: f.key,
            after: { session: f.caption.session, local: f.caption.local[1], broadcast: f.placement.interval[1] },
            note: '口播在会话末端被切断，后续区间尚未领得',
          });
        }
      }
      // 商品确定：优先明确标识；否则所有已落位片段候选交集中唯一者
      let product = null;
      const explicit = fragments.find((f) => f.attribution.explicit);
      if (explicit) {
        product = {
          merchant: explicit.caption.merchant, sku: explicit.caption.sku,
          basis: 'caption-explicit', record: explicit.caption.record, fragment: explicit.key,
        };
      } else {
        let common = null;
        for (const f of fragments) {
          if (!f.placement) continue;
          const set = new Map(f.attribution.candidates.map((c) => [`${c.merchant}/${c.sku}`, c]));
          common = common === null ? set : new Map([...common].filter(([k]) => set.has(k)));
        }
        if (common && common.size === 1) {
          const [c] = common.values();
          product = { merchant: c.merchant, sku: c.sku, basis: 'card-consensus', record: c.record };
        }
      }
      const placed = fragments.filter((f) => f.placement);
      const speechInterval = placed.length > 0
        ? [Math.min(...placed.map((f) => f.placement.interval[0])), Math.max(...placed.map((f) => f.placement.interval[1]))]
        : null;
      const status = missing.length === 0 && product ? 'complete' : 'partial';
      promises.set(id, { id, fragments, product, missing, speechInterval, status });
    }
    return promises;
  }

  // ---------------------------------------------------------------- 推算与回查

  #recompute() {
    const placements = new Map();
    const attributions = new Map();
    const facts = new Map();
    for (const [key, slot] of this.captions) {
      const cap = slot.current;
      const placement = this.placementFor(cap.session);
      const interval = placement ? [cap.local[0] + placement.offset, cap.local[1] + placement.offset] : null;
      const attribution = this.attributeCaption(cap, placement);
      placements.set(key, placement ? { ...placement, interval } : null);
      attributions.set(key, attribution);
      facts.set(key, {
        record: cap.record, revision: cap.revision,
        broadcast: interval, basis: placement ? placement.basis : null,
        candidates: attribution.candidates, uncovered: attribution.uncovered,
      });
    }
    const promises = this.#buildPromises(placements, attributions);
    this.derived = { placements, attributions, facts, promises };
    this.#reviewSubmissions();
    this.#reviewChecks();
  }

  /** 场控补发切卡、字幕修订等到达后，回查已提交证据并标明受影响的归属。 */
  #reviewSubmissions() {
    for (const sub of this.submissions) {
      const promise = this.derived.promises.get(sub.promise);
      if (!promise) {
        this.#addDispute(sub, { kind: 'promise-lost', note: '承诺片段已不在当前推算中' });
        continue;
      }
      for (const key of Object.keys(sub.facts)) {
        const before = sub.facts[key];
        const after = this.derived.facts.get(key);
        if (!after) {
          this.#addDispute(sub, { kind: 'fragment-lost', fragment: key, before });
          continue;
        }
        const changes = diffFacts(before, after);
        if (changes) {
          this.#addDispute(sub, {
            kind: 'fragment-facts-changed', fragment: key, changes,
            affectedAttributions: affectedAttributions(before.candidates, after.candidates),
          });
        }
      }
      const currentKeys = promise.fragments.map((f) => f.key).sort();
      if (!sameJson(currentKeys, Object.keys(sub.facts).sort())) {
        this.#addDispute(sub, { kind: 'promise-fragments-changed', before: Object.keys(sub.facts).sort(), after: currentKeys });
      }
      if (!sameJson(promise.speechInterval, sub.speechInterval)) {
        this.#addDispute(sub, { kind: 'speech-interval-changed', before: sub.speechInterval, after: promise.speechInterval });
      }
      // 商户版本：只有适用版本档集合变化才标争议；新到的现价版本不改写已提交解释
      const currentTerms = this.#bindPromiseTerms(promise);
      if (!sameJson(editionsSignature(currentTerms), editionsSignature(sub.terms))) {
        this.#addDispute(sub, { kind: 'terms-context-changed', before: editionsSignature(sub.terms), after: editionsSignature(currentTerms) });
      }
    }
  }

  #addDispute(sub, dispute) {
    const fingerprint = JSON.stringify(dispute);
    if (sub.disputes.some((d) => JSON.stringify({ ...d, at: undefined, seq: undefined }) === fingerprint)) return;
    sub.disputes.push({ seq: sub.disputes.length + 1, at: this.now(), ...dispute });
  }

  /** 回查打开中的检查项：其关注区间的归属事实变化时记入 affected。 */
  #reviewChecks() {
    for (const check of this.checks.values()) {
      if (check.status !== 'open') continue;
      const facts = this.derived.facts.get(captionKey(check.session, check.cue));
      if (!facts) continue;
      if (check.lastFacts === undefined) {
        this.#initCheckFacts(check);
        continue;
      }
      const changes = diffFacts(check.lastFacts, facts);
      if (changes) {
        check.affected.push({
          at: this.now(), changes,
          affectedAttributions: affectedAttributions(check.lastFacts.candidates, facts.candidates),
        });
        check.lastFacts = structuredClone(facts);
        check.consistent = check.claimedCard ? facts.candidates.some((c) => c.card === check.claimedCard) : null;
      }
    }
  }

  /** 以当前推算事实为检查项建立归属基线（领取批次进行中不调用，待重算统一建立）。 */
  #initCheckFacts(check) {
    if (check.lastFacts !== undefined) return;
    const facts = this.derived?.facts.get(captionKey(check.session, check.cue));
    if (!facts) return;
    check.lastFacts = structuredClone(facts);
    check.consistent = check.claimedCard ? facts.candidates.some((c) => c.card === check.claimedCard) : null;
  }

  // ---------------------------------------------------------------- 检查项与片段领用

  /**
   * 检查人员录入关注的口播区间。claimedCard 为检查员主张的商品卡，用于与推算候选对照。
   * 同一段视频可被多个检查项引用；租约按段计数。
   */
  registerCheck({ check, session, cue, card = null, record = null, revision = 1 }) {
    const existing = this.checks.get(check);
    if (existing) {
      if (revision > existing.revision) {
        Object.assign(existing, { session, cue, claimedCard: card, record, revision });
        existing.lastFacts = undefined;
        if (this.#applying === 0) this.#initCheckFacts(existing);
      }
      return existing;
    }
    const item = {
      id: check, session, cue, claimedCard: card, revision, record,
      source: record ? 'control' : 'local', status: 'open',
      segment: null, pendingLease: false, consistent: null, affected: [], lastFacts: undefined,
    };
    this.checks.set(check, item);
    this.#attachLease(item);
    if (this.#applying === 0) this.#initCheckFacts(item);
    return item;
  }

  #attachLease(check) {
    const slot = this.captions.get(captionKey(check.session, check.cue));
    if (!slot) {
      check.pendingLease = true; // 字幕尚未领到，租约挂起，到达后再挂接
      return;
    }
    const seg = segmentKey(slot.current.session, slot.current.part);
    if (!this.leases.has(seg)) this.leases.set(seg, new Set());
    this.leases.get(seg).add(check.id);
    check.segment = seg;
    check.pendingLease = false;
  }

  /** 结束单个检查：只释放它自己的租约，不影响同段视频上其他检查项的领用。 */
  closeCheck(id) {
    const check = this.checks.get(id);
    if (!check || check.status === 'closed') return false;
    check.status = 'closed';
    if (check.segment && this.leases.has(check.segment)) {
      const holders = this.leases.get(check.segment);
      holders.delete(id);
      if (holders.size === 0) this.leases.delete(check.segment);
    }
    return true;
  }

  /** 当前片段领用情况：段 -> 持有租约的检查项。 */
  leasesView() {
    return [...this.leases.entries()].map(([segment, holders]) => {
      const [session, part] = segment.split('/');
      const video = this.sessions.get(session)?.parts.get(part);
      return {
        segment, checks: [...holders].sort(),
        artifact: video?.artifact ?? null,
        credential: this.artifacts.get(video?.artifact) ?? null,
      };
    });
  }

  checksView() {
    return [...this.checks.values()].map((c) => ({
      id: c.id, session: c.session, cue: c.cue, claimedCard: c.claimedCard,
      status: c.status, segment: c.segment, pendingLease: c.pendingLease,
      consistent: c.consistent, affected: c.affected, record: c.record,
    }));
  }

  // ---------------------------------------------------------------- 版本绑定

  /**
   * 以口播当时的播出时码绑定商户版本档：只取 valid 与口播区间相交的版本，
   * 并给出覆盖子区间；口播区间内的无版本空档单独标出。
   */
  bindTerms(merchant, sku, interval) {
    const bindings = [];
    for (const e of this.terms) {
      if (e.merchant !== merchant || e.sku !== sku) continue;
      const s = Math.max(interval[0], e.valid[0]);
      const t = Math.min(interval[1], e.valid[1]);
      if (s < t) bindings.push({ edition: e.edition, shipment: e.shipment, covers: [s, t], record: e.record });
    }
    return { merchant, sku, interval, bindings, gaps: subtractInterval(interval, bindings.map((b) => b.covers)) };
  }

  #bindPromiseTerms(promise) {
    const product = promise.product && promise.speechInterval
      ? this.bindTerms(promise.product.merchant, promise.product.sku, promise.speechInterval)
      : null;
    const candidates = [];
    for (const f of promise.fragments) {
      if (!f.placement) continue;
      for (const c of f.attribution.candidates) {
        candidates.push({ fragment: f.key, card: c.card, ...this.bindTerms(c.merchant, c.sku, f.placement.interval) });
      }
    }
    return { product, candidates };
  }

  // ---------------------------------------------------------------- 提交与凭据

  /** 当前可提交清单：只含完整承诺；尚未归属或未收全的片段不混入。 */
  submittable() {
    if (!this.derived) return [];
    return [...this.derived.promises.values()]
      .filter((p) => p.status === 'complete')
      .map((p) => ({ id: p.id, product: p.product, speechInterval: p.speechInterval, fragments: p.fragments.map((f) => f.key) }));
  }

  /**
   * 提交一项完整承诺的证据包。冻结当时快照：片段凭据、归属候选、
   * 按时码纽带换算的播出区间、按口播当时上下文绑定的商户版本。
   * 不完整的承诺拒绝提交并说明缺失。
   */
  submit(promiseId, { check = null } = {}) {
    const promise = this.derived?.promises.get(promiseId);
    if (!promise) throw new Error(`未知承诺：${promiseId}`);
    if (promise.status !== 'complete') {
      throw new Error(`承诺 ${promiseId} 尚未收全，不能提交：${JSON.stringify(promise.missing)}`);
    }
    const submittedAt = this.now();
    const facts = {};
    for (const f of promise.fragments) facts[f.key] = structuredClone(this.derived.facts.get(f.key));
    const pkg = {
      id: `SUB-${this.submissions.length + 1}`,
      promise: promiseId, check,
      submittedAt, retentionUntil: submittedAt + this.retentionMs,
      product: promise.product,
      speechInterval: promise.speechInterval,
      fragments: promise.fragments.map((f) => ({
        key: f.key, source: 'replay', record: f.caption.record, revision: f.caption.revision,
        session: f.caption.session, cue: f.caption.cue, part: f.caption.part,
        local: f.caption.local, broadcast: f.placement.interval, basis: f.placement.basis,
        text: f.caption.text, artifact: this.#artifactCredential(f.caption.session, f.caption.part),
      })),
      facts,
      terms: this.#bindPromiseTerms(promise),
      disputes: [],
    };
    this.submissions.push(pkg);
    return pkg;
  }

  #artifactCredential(session, part) {
    const video = this.sessions.get(session)?.parts.get(part);
    if (!video?.artifact) return null;
    const cred = this.artifacts.get(video.artifact);
    return { artifact: video.artifact, sha256: cred?.sha256 ?? null, bytes: cred?.bytes ?? null, state: cred ? 'fetched' : 'not-fetched' };
  }

  /** 登记已领取原件的摘要凭据。 */
  attachArtifact(name, { sha256, bytes }) {
    this.artifacts.set(name, { sha256, bytes });
  }

  /** 尚未领取摘要的原件名。 */
  artifactsPending() {
    const names = new Set();
    for (const s of this.sessions.values()) {
      for (const v of s.parts.values()) {
        if (v.artifact && !this.artifacts.has(v.artifact)) names.add(v.artifact);
      }
    }
    return [...names];
  }

  /**
   * 内容撤回后的凭据查询：只返回保留期内的已提交片段凭据；
   * 尚未归属或未收全的片段从不进入此清单。
   */
  queryCredentials({ asOf = this.now() } = {}) {
    return this.submissions
      .filter((s) => s.retentionUntil >= asOf)
      .map((s) => ({
        id: s.id, promise: s.promise, check: s.check,
        submittedAt: s.submittedAt, retentionUntil: s.retentionUntil,
        product: s.product,
        fragments: s.fragments.map((f) => ({
          source: f.source, record: f.record, revision: f.revision,
          session: f.session, cue: f.cue, local: f.local, broadcast: f.broadcast,
          basis: f.basis, artifact: f.artifact,
        })),
        disputes: s.disputes.length,
      }));
  }

  submissionsView() {
    return this.submissions.map((s) => ({
      id: s.id, promise: s.promise, check: s.check,
      submittedAt: s.submittedAt, retentionUntil: s.retentionUntil,
      product: s.product, speechInterval: s.speechInterval,
      fragments: s.fragments.map((f) => ({ key: f.key, record: f.record, revision: f.revision, broadcast: f.broadcast })),
      terms: s.terms, disputes: s.disputes,
    }));
  }

  // ---------------------------------------------------------------- 视图与追查

  promiseView(id) {
    const p = this.derived?.promises.get(id);
    if (!p) return null;
    return {
      id: p.id, status: p.status, product: p.product, speechInterval: p.speechInterval, missing: p.missing,
      fragments: p.fragments.map((f) => ({
        key: f.key, record: f.caption.record, revision: f.caption.revision,
        session: f.caption.session, local: f.caption.local,
        broadcast: f.placement?.interval ?? null, basis: f.placement?.basis ?? null,
        text: f.caption.text, cut: f.cut,
        attribution: {
          status: f.attribution.status, basis: f.attribution.basis,
          product: f.attribution.product, candidates: f.attribution.candidates,
          uncovered: f.attribution.uncovered,
        },
      })),
    };
  }

  promisesView() {
    return [...(this.derived?.promises.keys() ?? [])].map((id) => this.promiseView(id));
  }

  /** 从商品正向追查：版本档、商品卡、口播、承诺、检查项、已提交证据与争议。 */
  traceProduct(merchant, sku) {
    const match = (m, s) => m === merchant && s === sku;
    const captions = [];
    for (const [key, slot] of this.captions) {
      const cap = slot.current;
      const att = this.derived?.attributions.get(key);
      const explicit = match(cap.merchant, cap.sku);
      const candidate = Boolean(att?.candidates.some((c) => match(c.merchant, c.sku)));
      if (explicit || candidate) {
        captions.push({
          key, source: 'replay', record: cap.record, revision: cap.revision,
          role: explicit ? 'explicit' : 'candidate',
          broadcast: this.derived.placements.get(key)?.interval ?? null,
          basis: explicit ? 'caption-explicit' : 'card-overlap',
        });
      }
    }
    const cards = [...this.cards.values()]
      .filter((slot) => match(slot.current.merchant, slot.current.sku))
      .map((slot) => ({
        card: slot.current.card, source: 'control', record: slot.current.record,
        revision: slot.current.revision, span: slot.current.span,
        history: slot.history.map((h) => ({ record: h.record, revision: h.revision, span: h.span })),
      }));
    const terms = this.terms.filter((t) => match(t.merchant, t.sku))
      .map((t) => ({ edition: t.edition, shipment: t.shipment, valid: t.valid, source: 'listings', record: t.record }));
    const promises = [...(this.derived?.promises.values() ?? [])]
      .filter((p) => (p.product && match(p.product.merchant, p.product.sku))
        || p.fragments.some((f) => f.attribution.candidates.some((c) => match(c.merchant, c.sku))))
      .map((p) => ({ id: p.id, status: p.status, missing: p.missing }));
    const checks = this.checksView().filter((c) => {
      const facts = this.derived?.facts.get(captionKey(c.session, c.cue));
      return (c.claimedCard && cards.some((k) => k.card === c.claimedCard))
        || facts?.candidates.some((k) => match(k.merchant, k.sku));
    });
    const submissions = this.submissions
      .filter((s) => s.product && match(s.product.merchant, s.product.sku))
      .map((s) => ({ id: s.id, retentionUntil: s.retentionUntil, disputes: s.disputes }));
    const disputes = this.submissions.flatMap((s) => s.disputes
      .filter((d) => (d.affectedAttributions ?? []).some((a) => match(a.merchant, a.sku)))
      .map((d) => ({ submission: s.id, ...d })));
    return { merchant, sku, terms, cards, captions, promises, checks, submissions, disputes };
  }

  /**
   * 从口播区间反向追查：给出会话相对时码或播出时码，
   * 返回落位依据、涉及字幕与商品卡、归属候选、空档与争议。
   */
  traceInterval(query) {
    let interval;
    let basis = 'broadcast';
    let broadcast = query.broadcastId ?? null;
    if (query.session) {
      const placement = this.placementFor(query.session);
      if (!placement) return { placed: false, reason: '会话未拼回时轴，缺少平台时码映射', session: query.session };
      interval = [query.local[0] + placement.offset, query.local[1] + placement.offset];
      basis = placement.basis;
      broadcast = this.sessions.get(query.session)?.broadcast ?? null;
    } else {
      interval = query.broadcast;
    }
    const captions = [];
    for (const [key, slot] of this.captions) {
      const placed = this.derived?.placements.get(key);
      if (!placed || !overlaps(placed.interval, interval)) continue;
      const att = this.derived.attributions.get(key);
      captions.push({
        key, source: 'replay', record: slot.current.record, revision: slot.current.revision,
        broadcast: placed.interval, basis: placed.basis,
        attribution: { status: att.status, basis: att.basis, candidates: att.candidates, uncovered: att.uncovered },
      });
    }
    const cards = [...this.cards.values()]
      .map((slot) => slot.current)
      .filter((c) => (!broadcast || c.broadcast === broadcast) && overlaps(c.span, interval))
      .map((c) => ({ card: c.card, merchant: c.merchant, sku: c.sku, span: c.span, revision: c.revision, source: 'control', record: c.record }));
    const disputes = this.submissions.flatMap((s) => s.disputes
      .filter((d) => {
        const f = s.fragments.find((x) => x.key === d.fragment);
        return f && overlaps(f.broadcast, interval);
      })
      .map((d) => ({ submission: s.id, ...d })));
    return { placed: true, interval, basis, captions, cards, disputes };
  }
}
