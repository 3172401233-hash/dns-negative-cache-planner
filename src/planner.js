/**
 * DNS 否定缓存规划器（纯函数，不访问真实 DNS）。
 *
 * 核心语义：
 * - NXDOMAIN 作用于“名称”，对该名称的所有 qtype 生效。
 * - NODATA（NOERROR + 空应答）作用于“名称 + qtype”，不同 qtype 互不影响。
 * - SERVFAIL 是临时故障，永远不能固化为持久否定缓存；
 *   上游短暂异常时仅允许在配置的有限窗口内使用 stale。
 * - CNAME 链中每个节点独立规划，某个节点失败不覆盖最终目标的判断。
 * - 时间（now，毫秒）必须由调用方传入，便于重复测试。
 */

export const DEFAULT_CONFIG = Object.freeze({
  // 否定缓存 TTL 上限：SOA minimum / SOA TTL 再大也不会超过它
  maxNegativeTtlMs: 60 * 60 * 1000,
  // 否定缓存 TTL 下限（0 表示不强制下限）
  minNegativeTtlMs: 0,
  // 上游异常时允许使用过期条目的有限 stale 窗口；0 表示禁用 stale
  staleIfErrorMs: 30 * 1000,
});

const VALID_RCODE = new Set(['NOERROR', 'NXDOMAIN', 'SERVFAIL']);
const NODE_FAILURE = new Set(['servfail', 'timeout', 'nxdomain', 'nodata']);

export function normalizeName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('name 必须是非空字符串');
  }
  const lower = name.trim().toLowerCase();
  return lower.endsWith('.') ? lower : `${lower}.`;
}

/**
 * 生成缓存键。
 * kind = 'nxdomain' → 名称级：nxdomain|<name>
 * kind = 'nodata'   → 名称+类型级：nodata|<name>|<qtype>
 */
export function negativeCacheKey(kind, name, qtype) {
  const normalized = normalizeName(name);
  if (kind === 'nxdomain') return `nxdomain|${normalized}`;
  if (kind === 'nodata') {
    if (qtype === undefined || qtype === null || qtype === '') {
      throw new TypeError('NODATA 缓存键必须携带 qtype');
    }
    return `nodata|${normalized}|${String(qtype).toUpperCase()}`;
  }
  throw new TypeError(`未知的否定缓存类型: ${kind}`);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function stalePolicy(cfg) {
  return {
    allowed: cfg.staleIfErrorMs > 0,
    maxStaleMs: cfg.staleIfErrorMs,
    onlyWhenUpstreamUnhealthy: true,
  };
}

function notCacheable(kind, reason, extra = {}) {
  return {
    kind,
    cacheable: false,
    key: null,
    ttlMs: 0,
    expiresAt: null,
    staleUntil: null,
    reason,
    ...extra,
  };
}

/**
 * 计算否定条目 TTL（RFC 2308）：min(SOA.minimum, SOA.ttl)，
 * 再夹取到 [minNegativeTtlMs, maxNegativeTtlMs]。
 */
function negativeTtlMs(soa, cfg) {
  const candidates = [];
  if (Number.isFinite(soa.minimum)) candidates.push(soa.minimum);
  if (Number.isFinite(soa.ttl)) candidates.push(soa.ttl);
  if (candidates.length === 0) return null;
  const seconds = Math.min(...candidates);
  return clamp(seconds * 1000, cfg.minNegativeTtlMs, cfg.maxNegativeTtlMs);
}

function planNegative({ kind, name, qtype, soa, now, cfg }) {
  if (!soa || (!Number.isFinite(soa.minimum) && !Number.isFinite(soa.ttl))) {
    return notCacheable(
      kind,
      'authority 段缺少 SOA，无法确定否定 TTL，按 RFC 2308 不缓存',
      { stale: stalePolicy(cfg) },
    );
  }
  const ttlMs = negativeTtlMs(soa, cfg);
  const expiresAt = now + ttlMs;
  return {
    kind,
    cacheable: true,
    key: negativeCacheKey(kind, name, qtype),
    ttlMs,
    expiresAt,
    staleUntil: expiresAt + cfg.staleIfErrorMs,
    reason: null,
    stale: stalePolicy(cfg),
  };
}

function planChainNode(node, now, cfg) {
  const name = normalizeName(node.name);
  const status = node.status ?? 'ok';
  const base = {
    name,
    target: node.target ? normalizeName(node.target) : null,
    status,
    ok: status === 'ok',
  };
  if (status === 'ok') return { ...base, decision: null };
  if (!NODE_FAILURE.has(status)) {
    throw new TypeError(`未知的 CNAME 节点状态: ${status}`);
  }
  if (status === 'servfail' || status === 'timeout') {
    return {
      ...base,
      decision: notCacheable(status, '节点临时故障，不生成否定缓存', {
        stale: stalePolicy(cfg),
      }),
    };
  }
  // 节点级 NXDOMAIN / NODATA：只作用于该节点名称，不影响最终目标
  return {
    ...base,
    decision: planNegative({
      kind: status,
      name,
      qtype: node.qtype,
      soa: node.soa ?? null,
      now,
      cfg,
    }),
  };
}

/**
 * 规划一次解析结果的否定缓存行为。
 *
 * @param {object} input
 * @param {number} input.now            当前时间（毫秒，必填，由调用方注入）
 * @param {string} input.qname          查询名称
 * @param {string} input.qtype          查询类型（如 'A'、'AAAA'）
 * @param {string} input.rcode          最终应答状态：'NOERROR' | 'NXDOMAIN' | 'SERVFAIL'
 * @param {object|null} [input.soa]     所属区域的 SOA：{ minimum, ttl }（秒）
 * @param {Array}  [input.cnameChain]   CNAME 链节点：{ name, target, status, soa?, qtype? }
 * @param {object} [input.upstream]     上游健康状态：{ healthy: boolean }
 * @param {object} [input.config]       覆盖 DEFAULT_CONFIG 的配置
 */
export function planNegativeCache(input) {
  const {
    now,
    qname,
    qtype,
    rcode,
    soa = null,
    cnameChain = [],
    upstream = { healthy: true },
    config = {},
  } = input ?? {};

  if (!Number.isFinite(now)) {
    throw new TypeError('now（毫秒时间戳）必须由调用方传入');
  }
  if (!VALID_RCODE.has(rcode)) {
    throw new TypeError(`不支持的 rcode: ${rcode}`);
  }
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const normalizedQname = normalizeName(qname);

  const chain = cnameChain.map((node) => planChainNode(node, now, cfg));
  const chainFailed = chain.some((node) => !node.ok);

  let final;
  if (rcode === 'SERVFAIL') {
    final = notCacheable(
      'servfail',
      'SERVFAIL 是临时故障，不能转换为持久否定结果',
      { stale: stalePolicy(cfg) },
    );
  } else if (rcode === 'NXDOMAIN') {
    final = planNegative({ kind: 'nxdomain', name: normalizedQname, soa, now, cfg });
  } else {
    // NOERROR 且走到否定规划，即 NODATA（应答为空）
    final = planNegative({
      kind: 'nodata',
      name: normalizedQname,
      qtype,
      soa,
      now,
      cfg,
    });
  }

  return {
    now,
    qname: normalizedQname,
    qtype: qtype ? String(qtype).toUpperCase() : null,
    rcode,
    upstreamHealthy: Boolean(upstream.healthy),
    chain,
    chainFailed,
    final,
  };
}

/**
 * 判断一个已缓存条目在 now 时刻的状态。
 * @returns {'fresh' | 'stale-usable' | 'expired'}
 */
export function entryState(entry, now, upstreamHealthy) {
  if (!entry || !Number.isFinite(entry.expiresAt)) return 'expired';
  if (now < entry.expiresAt) return 'fresh';
  const staleUntil = entry.staleUntil ?? entry.expiresAt;
  if (!upstreamHealthy && now < staleUntil) return 'stale-usable';
  return 'expired';
}

/** 过期条目此刻是否可作为 stale 使用（仅在上游不健康时）。 */
export function canServeStale(entry, now, upstreamHealthy) {
  return entryState(entry, now, upstreamHealthy) === 'stale-usable';
}
