// 世界自己的随机源。
//
// 为什么不用 Math.random：注释里写着「确定性 tick」，但只要内核里还散着
// Math.random，同一份存档跑两遍就会长出两个不同的世界，回放、对比实验、
// 复现 bug 全部作废。所以模拟里的一切随机都必须从这一个 32 位状态流里取，
// 而这个状态是可序列化的 —— 存档带上状态，读档后继续跑，结果分毫不差。
//
// 算法用 mulberry32：状态只有一个 uint32，够随机、够快、实现只有几行，
// 不依赖 BigInt，JSON 里存一个整数就行。

/** 把一个整数（或字符串）揉成 32 位种子 */
export function hashSeed(input) {
  let h = 0x811c9dc5;
  const s = String(input ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 0x9e3779b9;
}

export class Rng {
  constructor(seed = 1) {
    this.state = (hashSeed(seed) || 1) >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** [0, 1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, n) 整数 */
  int(n) {
    const k = Math.floor(Number(n));
    if (!Number.isFinite(k) || k <= 0) return 0;
    return Math.floor(this.next() * k);
  }

  /** 闭区间整数 [lo, hi] */
  range(lo, hi) {
    const a = Math.floor(Number(lo) || 0);
    const b = Math.floor(Number(hi) || 0);
    if (b <= a) return a;
    return a + this.int(b - a + 1);
  }

  /** 概率 p 命中 */
  chance(p) {
    const q = Number(p);
    if (!Number.isFinite(q) || q <= 0) return false;
    if (q >= 1) return true;
    return this.next() < q;
  }

  /** 从数组里挑一个（空数组返回 undefined） */
  pick(list) {
    if (!Array.isArray(list) || !list.length) return undefined;
    return list[this.int(list.length)];
  }

  /** 保存 / 恢复：数值存档的一部分 */
  toJSON() {
    return this.state >>> 0;
  }

  static from(state, fallbackSeed = 1) {
    const r = new Rng(fallbackSeed);
    const n = Number(state);
    if (Number.isFinite(n) && n > 0) r.state = Math.floor(n) >>> 0;
    return r;
  }
}
