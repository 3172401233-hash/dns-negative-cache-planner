import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  normalizeName,
  negativeCacheKey,
  planNegativeCache,
  entryState,
  canServeStale,
} from '../index.js';

const NOW = 1_800_000_000_000; // 固定时间，测试可重复
const SOA = { minimum: 300, ttl: 600 }; // 秒

test('NXDOMAIN：作用于名称，键不含 qtype，TTL 取 min(SOA.minimum, SOA.ttl)', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'WWW.Example.COM',
    qtype: 'A',
    rcode: 'NXDOMAIN',
    soa: SOA,
  });
  assert.equal(plan.final.cacheable, true);
  assert.equal(plan.final.kind, 'nxdomain');
  assert.equal(plan.final.key, 'nxdomain|www.example.com.');
  assert.equal(plan.final.ttlMs, 300_000);
  assert.equal(plan.final.expiresAt, NOW + 300_000);
  assert.equal(
    plan.final.staleUntil,
    NOW + 300_000 + DEFAULT_CONFIG.staleIfErrorMs,
  );
});

test('NXDOMAIN：同一名称不同 qtype 命中同一条名称级缓存', () => {
  const a = planNegativeCache({ now: NOW, qname: 'x.example.com', qtype: 'A', rcode: 'NXDOMAIN', soa: SOA });
  const aaaa = planNegativeCache({ now: NOW, qname: 'x.example.com', qtype: 'AAAA', rcode: 'NXDOMAIN', soa: SOA });
  assert.equal(a.final.key, aaaa.final.key);
});

test('否定 TTL 上限：SOA minimum 超过配置上限时被夹取', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'huge.example.com',
    qtype: 'A',
    rcode: 'NXDOMAIN',
    soa: { minimum: 86400, ttl: 86400 },
    config: { maxNegativeTtlMs: 60_000 },
  });
  assert.equal(plan.final.ttlMs, 60_000);
  assert.equal(plan.final.expiresAt, NOW + 60_000);
});

test('NODATA：键区分 qtype，同域名不同 qtype 互不影响', () => {
  const a = planNegativeCache({ now: NOW, qname: 'www.example.com', qtype: 'A', rcode: 'NOERROR', soa: SOA });
  const aaaa = planNegativeCache({ now: NOW, qname: 'www.example.com', qtype: 'AAAA', rcode: 'NOERROR', soa: SOA });
  assert.equal(a.final.kind, 'nodata');
  assert.equal(a.final.key, 'nodata|www.example.com.|A');
  assert.equal(aaaa.final.key, 'nodata|www.example.com.|AAAA');
  assert.notEqual(a.final.key, aaaa.final.key);
});

test('SOA 缺失：NXDOMAIN 与 NODATA 都不缓存', () => {
  const nx = planNegativeCache({ now: NOW, qname: 'a.example.com', qtype: 'A', rcode: 'NXDOMAIN', soa: null });
  const nd = planNegativeCache({ now: NOW, qname: 'a.example.com', qtype: 'A', rcode: 'NOERROR' });
  assert.equal(nx.final.cacheable, false);
  assert.equal(nd.final.cacheable, false);
  assert.equal(nx.final.expiresAt, null);
  assert.match(nx.final.reason, /SOA/);
});

test('SERVFAIL：不能转换为持久否定结果', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'flaky.example.com',
    qtype: 'A',
    rcode: 'SERVFAIL',
    soa: SOA,
  });
  assert.equal(plan.final.cacheable, false);
  assert.equal(plan.final.key, null);
  assert.equal(plan.final.expiresAt, null);
  assert.match(plan.final.reason, /临时故障/);
});

test('CNAME 链：中间节点 SERVFAIL 不覆盖最终目标的 NXDOMAIN 判断', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'alias.example.com',
    qtype: 'A',
    rcode: 'NXDOMAIN',
    soa: SOA,
    cnameChain: [
      { name: 'alias.example.com', target: 'hop.cdn.net', status: 'ok' },
      { name: 'hop.cdn.net', target: 'edge.cdn.net', status: 'servfail' },
    ],
  });
  assert.equal(plan.chainFailed, true);
  assert.equal(plan.chain[1].ok, false);
  assert.equal(plan.chain[1].decision.cacheable, false);
  // 最终目标独立判断，仍然可以缓存 NXDOMAIN
  assert.equal(plan.final.cacheable, true);
  assert.equal(plan.final.key, 'nxdomain|alias.example.com.');
});

test('CNAME 链：节点级 NXDOMAIN 只作用于该节点名称', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'alias.example.com',
    qtype: 'A',
    rcode: 'NOERROR',
    soa: SOA,
    cnameChain: [
      { name: 'hop.cdn.net', target: null, status: 'nxdomain', soa: { minimum: 60, ttl: 60 } },
    ],
  });
  const nodeDecision = plan.chain[0].decision;
  assert.equal(nodeDecision.cacheable, true);
  assert.equal(nodeDecision.key, 'nxdomain|hop.cdn.net.');
  // 最终目标按自身 NOERROR(NODATA) 规划，不被节点失败污染
  assert.equal(plan.final.kind, 'nodata');
  assert.equal(plan.final.key, 'nodata|alias.example.com.|A');
});

test('stale：仅上游不健康且在有限窗口内可用，窗口外过期', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'www.example.com',
    qtype: 'A',
    rcode: 'NXDOMAIN',
    soa: SOA,
    config: { staleIfErrorMs: 10_000 },
  });
  const entry = plan.final;
  const freshAt = NOW + 299_999;
  const staleAt = NOW + 305_000; // 已过期，但在 10s stale 窗口内
  const deadAt = NOW + 310_001; // 超出 stale 窗口

  assert.equal(entryState(entry, freshAt, false), 'fresh');
  assert.equal(canServeStale(entry, staleAt, false), true);
  // 上游健康时不允许使用 stale
  assert.equal(canServeStale(entry, staleAt, true), false);
  // stale 窗口之外彻底过期
  assert.equal(entryState(entry, deadAt, false), 'expired');
  assert.equal(canServeStale(entry, deadAt, false), false);
});

test('stale 窗口为 0 时禁用 stale', () => {
  const plan = planNegativeCache({
    now: NOW,
    qname: 'www.example.com',
    qtype: 'A',
    rcode: 'NXDOMAIN',
    soa: SOA,
    config: { staleIfErrorMs: 0 },
  });
  assert.equal(plan.final.stale.allowed, false);
  assert.equal(canServeStale(plan.final, NOW + 301_000, false), false);
});

test('工具函数：normalizeName 与 negativeCacheKey', () => {
  assert.equal(normalizeName('Example.COM'), 'example.com.');
  assert.equal(negativeCacheKey('nxdomain', 'a.com', 'AAAA'), 'nxdomain|a.com.');
  assert.equal(negativeCacheKey('nodata', 'a.com', 'mx'), 'nodata|a.com.|MX');
  assert.throws(() => negativeCacheKey('nodata', 'a.com'), /qtype/);
});

test('时间必须由调用方传入', () => {
  assert.throws(
    () => planNegativeCache({ qname: 'a.com', qtype: 'A', rcode: 'NXDOMAIN', soa: SOA }),
    /now/,
  );
});
