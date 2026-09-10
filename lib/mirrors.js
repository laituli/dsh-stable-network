/**
 * 镜像源信息管理（纯逻辑 + 注入式 IO，可离线单测）。
 *
 * 目的（issue laituli/dsh-personal#2 的“CN2GIT”背景）：把“国内可达的替代源”集中成一份可读、
 * 可切换、可校验的信息，供上层（git 推送、npm 安装、skill 注入）按需取用。
 * 本模块只做**信息与选择**，不执行网络动作、不改宿主配置。
 */

/** 内置候选（可按需增删；active 表示当前选择）。 */
export const BUILTIN_MIRRORS = Object.freeze({
  npm: [
    { id: 'npmjs', url: 'https://registry.npmjs.org', note: '官方源（海外）' },
    { id: 'npmmirror', url: 'https://registry.npmmirror.com', note: '阿里云 npmmirror（国内快）' },
  ],
  pypi: [
    { id: 'pypi', url: 'https://pypi.org/simple', note: '官方源' },
    { id: 'aliyun', url: 'https://mirrors.aliyun.com/pypi/simple', note: '阿里云镜像' },
    { id: 'tuna', url: 'https://pypi.tuna.tsinghua.edu.cn/simple', note: '清华 TUNA' },
  ],
  github: [
    { id: 'direct', url: 'https://github.com', note: '直连（抖动时配合刚性重试）' },
    { id: 'ghproxy', url: 'https://ghfast.top/https://github.com', note: '公共加速前缀（可用性需自检）' },
  ],
});

export function createMirrorRegistry(options) {
  const opt = options || {};
  const io = opt.io || { read: () => null, write: () => {} };
  let active = {};
  try {
    const raw = io.read();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') active = parsed;
    }
  } catch (e) { active = {}; }

  function persist() { try { io.write(JSON.stringify(active)); } catch (e) { /* 忽略 */ } }

  /** 列出某类镜像的全部候选（含 active 标记）。 */
  function list(kind) {
    const builtin = BUILTIN_MIRRORS[kind] || [];
    const extra = Array.isArray(active[kind + ':extra']) ? active[kind + ':extra'] : [];
    const chosen = active[kind];
    return builtin.concat(extra).map(function (m) {
      return { id: m.id, url: m.url, note: m.note, active: m.id === chosen || m.url === chosen };
    });
  }

  /** 选择某类的镜像（可用内置 id、也可直接给 URL）。 */
  function set(kind, idOrUrl) {
    const target = String(idOrUrl || '');
    if (!target) { delete active[kind]; persist(); return { ok: true, active: null }; }
    const hit = (BUILTIN_MIRRORS[kind] || []).find(function (m) { return m.id === target || m.url === target; });
    const value = hit ? hit.id : target;
    active[kind] = value;
    persist();
    return { ok: true, active: value, url: resolve(kind) };
  }

  /** 解析出该类当前应使用的 URL（未选则用内置第一项）。 */
  function resolve(kind) {
    const chosen = active[kind];
    const builtin = BUILTIN_MIRRORS[kind] || [];
    if (!chosen) return builtin.length ? builtin[0].url : null;
    const hit = builtin.find(function (m) { return m.id === chosen; });
    return hit ? hit.url : chosen;
  }

  /** 整体快照（供状态/UI 读取）。 */
  function snapshot() {
    const kinds = Object.keys(BUILTIN_MIRRORS);
    const out = {};
    for (const k of kinds) out[k] = { active: active[k] || null, url: resolve(k), candidates: list(k) };
    return out;
  }

  return { list: list, set: set, resolve: resolve, snapshot: snapshot };
}
