import { createHash } from 'node:crypto';

/**
 * 来源服务的分页领取客户端。
 * 负责从回放服务分段领取回放索引与转写修订、从场控日志领取商品卡交接、
 * 从商品资料口领取公告成分与承诺版本，并按阶段领取原件。
 * 只使用 Node.js 自带运行库。
 */
export class SourceClient {
  constructor(baseUrl, { limit = 3 } = {}) {
    if (!baseUrl) throw new Error('缺少来源服务地址');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('分页 limit 须为 1 至 100');
    this.limit = limit;
  }

  async #getJson(path) {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} 失败：${response.status}`);
    return response.json();
  }

  /** 来源概览：当前回放阶段、来源清单、阶段总数。 */
  overview() {
    return this.#getJson('/');
  }

  /** 演练控制口：切换到指定回放阶段。 */
  async advance(stage) {
    const response = await fetch(`${this.baseUrl}/control?stage=${stage}`, { method: 'POST' });
    if (!response.ok) throw new Error(`切换回放阶段 ${stage} 失败：${response.status}`);
    return response.json();
  }

  /** 按 next 游标分段领取一个来源在当前阶段的全部记录。 */
  async *pages(name) {
    let offset = 0;
    do {
      const page = await this.#getJson(`/source/${name}?offset=${offset}&limit=${this.limit}`);
      if (page.next !== null && page.next <= offset) throw new Error(`来源 ${name} 分页游标未前进`);
      yield page;
      offset = page.next;
    } while (offset !== null);
  }

  /** 领取一个来源当前阶段的全部记录（按到达顺序）。 */
  async pull(name) {
    const records = [];
    for await (const page of this.pages(name)) records.push(...page.records);
    return records;
  }

  /** 领取全部来源的当前阶段记录，返回 { 来源名: 记录数组 }。 */
  async pullAll(names) {
    const bundle = {};
    for (const name of names) bundle[name] = await this.pull(name);
    return bundle;
  }

  /**
   * 领取原件字节并计算 SHA-256 摘要；阶段内尚不可领时返回 null。
   * 摘要作为片段凭据的一部分留存。
   */
  async artifact(name) {
    const response = await fetch(`${this.baseUrl}/original/${encodeURIComponent(name)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`领取原件 ${name} 失败：${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { artifact: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
