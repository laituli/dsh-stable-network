/**
 * 待处理队列（纯逻辑 + 注入式 IO，便于离线单测）。
 *
 * 用途：网络不可达期间，把“本来要做但做不了的网络类动作”挂起来（例如一次同步请求）；
 * 网络恢复后由上层（或注册的回调）取出补做。**本模块不执行任何网络动作、不依赖其它插件**。
 */

let seq = 0;
function nextId(now) {
  seq += 1;
  return String(now) + '-' + seq;
}

/**
 * @param options.storePath 持久化路径（仅用于记录来源，实际读写由 io 提供）
 * @param options.io { read(): string|null, write(text): void } —— 测试可注入内存实现
 * @param options.now 可注入时钟（测试用）
 */
export function createPendingQueue(options) {
  const opt = options || {};
  const io = opt.io || { read: () => null, write: () => {} };
  const now = typeof opt.now === 'function' ? opt.now : () => Date.now();
  const maxItems = Number.isFinite(opt.maxItems) ? opt.maxItems : 200;
  let items = [];

  try {
    const raw = io.read();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) items = parsed.filter((x) => x && typeof x.kind === 'string');
    }
  } catch (e) {
    items = []; // 文件损坏视为空队列，不阻塞启动
  }

  function persist() {
    try { io.write(JSON.stringify(items)); } catch (e) { /* 落盘失败不影响内存队列 */ }
  }

  function add(kind, label) {
    const item = { id: nextId(now()), kind: String(kind || ''), label: label == null ? null : String(label), at: now() };
    items.push(item);
    if (items.length > maxItems) items = items.slice(items.length - maxItems);
    persist();
    return item;
  }

  function list() { return items.slice(); }
  function size() { return items.length; }

  function remove(id) {
    const before = items.length;
    items = items.filter((x) => x.id !== id);
    if (items.length !== before) persist();
    return items.length !== before;
  }

  /** 取出全部并从队列移除（补做时调用；返回的是快照）。 */
  function drain() {
    const out = items.slice();
    if (out.length) { items = []; persist(); }
    return out;
  }

  return { add: add, list: list, size: size, remove: remove, drain: drain };
}
