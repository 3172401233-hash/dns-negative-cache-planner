# dns-negative-cache-planner

纯函数式 DNS 否定缓存规划库（ES Modules，Node.js >= 24.16.0）。库本身**不访问真实 DNS**：
调用方传入一次解析的全部事实，库返回“是否缓存、缓存键、过期时间、stale 策略”的规划结果。
时间（`now`，毫秒时间戳）必须由调用方注入，便于重复测试。

## 缓存语义

| 场景 | 是否缓存 | 缓存键 | 作用域 |
| --- | --- | --- | --- |
| NXDOMAIN | 是（需 SOA） | `nxdomain\|<name>` | 名称级，对该名称所有 qtype 生效 |
| NODATA（NOERROR + 空应答） | 是（需 SOA） | `nodata\|<name>\|<qtype>` | 名称 + qtype 级，不同 qtype 互不影响 |
| SERVFAIL | **否** | — | 临时故障，永远不能固化为持久否定结果 |
| 缺少 SOA 的否定应答 | 否 | — | 无法确定否定 TTL，按 RFC 2308 不缓存 |

- 名称统一规范化为小写、带结尾点（`WWW.Example.COM` → `www.example.com.`）。
- CNAME 链中每个节点独立规划：中间节点失败（如 SERVFAIL）只影响该节点自身，
  **不覆盖最终目标**的判断；节点级 NXDOMAIN 也只作用于该节点名称。

## TTL 与上限

否定条目 TTL 按 RFC 2308 计算，再夹取到配置区间：

```
ttlMs = clamp(min(SOA.minimum, SOA.ttl) * 1000, minNegativeTtlMs, maxNegativeTtlMs)
```

默认配置（`DEFAULT_CONFIG`，可用 `config` 逐项覆盖）：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `maxNegativeTtlMs` | 3 600 000（1 小时） | 否定缓存 TTL 上限，SOA 再大也不会超过 |
| `minNegativeTtlMs` | 0 | 否定缓存 TTL 下限 |
| `staleIfErrorMs` | 30 000 | 上游异常时允许使用过期条目的有限 stale 窗口；0 表示禁用 |

## Stale 降级

条目过期后进入长度最多为 `staleIfErrorMs` 的 stale 窗口（`staleUntil = expiresAt + staleIfErrorMs`）。
仅当**上游不健康**且当前时间仍在窗口内时，`canServeStale(entry, now, upstreamHealthy)`
返回 `true`；窗口之外彻底过期。SERVFAIL 自身不产生任何缓存条目，只能触发对既有条目的
有限 stale 使用，避免临时故障被当成“域名不存在”长期保留。

## API

```js
import { planNegativeCache, entryState, canServeStale } from 'dns-negative-cache-planner';

const plan = planNegativeCache({
  now: Date.now(),            // 必填，由调用方注入
  qname: 'www.example.com',
  qtype: 'A',
  rcode: 'NXDOMAIN',          // 'NOERROR'(NODATA) | 'NXDOMAIN' | 'SERVFAIL'
  soa: { minimum: 300, ttl: 600 }, // 秒；缺失时否定结果不缓存
  cnameChain: [
    { name: 'alias.example.com', target: 'edge.cdn.net', status: 'ok' },
  ],
  upstream: { healthy: true },
  config: { maxNegativeTtlMs: 600_000 },
});

plan.final; // { cacheable, key, ttlMs, expiresAt, staleUntil, stale, ... }
plan.chain; // 每个 CNAME 节点的独立规划
```

## 测试

```sh
node --test
```

覆盖 NXDOMAIN、NODATA（含同域名不同 qtype）、SOA 缺失、CNAME 链节点失败、
SERVFAIL 不持久化、stale 窗口到期等场景。
