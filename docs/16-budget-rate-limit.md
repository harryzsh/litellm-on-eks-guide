# Budget 管控与速率限制

LiteLLM 在 Virtual Key / User / Team 三层上都支持预算（$ 消费上限）和速率（RPM/TPM）限制，搭配 RDS Postgres 做持久化和追踪。本章讲清楚：**层级关系、配额含义、重置机制、落地建议**。

> 参考：
> - LiteLLM 用户管理：https://docs.litellm.ai/docs/proxy/users
> - Team budgets：https://docs.litellm.ai/docs/proxy/team_budgets
> - Budget reset 与时区：https://docs.litellm.ai/docs/proxy/budget_reset_and_tz

## Budget 三层模型：Team / Team Member / Key

LiteLLM 的 Budget 有**四个可设置对象**，实际用起来主要是前三层：

| 对象 | 创建方式 | 关键字段 | 作用范围 |
|---|---|---|---|
| **Team** | Admin UI → Teams 新建，或 `POST /team/new` | `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit` | 整个团队所有 Key 共享的预算池 |
| **Team Member** | `POST /team/member_add` 时带 `max_budget_in_team` | `max_budget_in_team` | 在团队池子里，限制单个成员能花的上限 |
| **Key (Virtual Key)** | Admin UI → Virtual Keys，或 `POST /key/generate` | `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit` | 单把 Key 自己的上限 |
| Internal User | `POST /user/new` | `max_budget`, `budget_duration` | 一个用户名下**不属于任何 Team** 的所有 Key 共享 |

### 继承与优先级

```
请求到达 LiteLLM
   ↓
  取 Key
   ↓
Key 有 team_id？
   ├── 有  → Team 预算 + Team Member 预算（都要过）+ Key 自身预算（可选）
   └── 没  → User 预算（key 的 user_id 对应）+ Key 自身预算（可选）
```

**官方原话**：*If a key belongs to a team, the team budget is applied, not the user's personal budget.*（Key 绑了 Team，User 预算就不生效了，Team 预算才生效。）

三层同时设置时的拦截顺序（任一触发都会 reject 请求）：

1. **Team 池子**：整个团队本周期已经花到 `max_budget` → 整队所有 Key 都停
2. **Team Member（`max_budget_in_team`）**：这个成员在团队里的消耗到顶 → 只停这个成员的 Key
3. **Key 自身 `max_budget`**：这把 Key 自己到顶 → 只停这把 Key

建议的设置思路：

- **Team**：按业务线定总预算，粗粒度
- **Team Member**：给每人一个"团队内额度"防止单人烧干
- **Key**：一般不设，除非给某个特殊项目 / 脚本单独卡死

### 场景示例

| 场景 | 怎么配 |
|---|---|
| 部门每月 $5000 总额，不限人头 | Team: `max_budget=5000, budget_duration=30d`；成员和 Key 不设 |
| 部门每月 $5000，每人最多 $300 | Team: `max_budget=5000`；成员加入时 `max_budget_in_team=300` |
| 某个爬虫 Key 单独限 $50/周 | Key: `max_budget=50, budget_duration=7d` |
| 外部合作方一次性 $10 试用 | Key: `max_budget=10`（不设 duration，花完即失效） |

### Admin UI 操作路径

- **新建 Team**：`Admin UI → Teams → + New Team` → 填 `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit`
- **把人加到 Team + 给单人限额**：Team 详情页 → `Add Member` → 勾 `Set Max Budget In Team` → 填金额
- **新建 Key**：`Admin UI → Virtual Keys → + Create New Key` → 选 Team（或不选）→ 可选 `Max Budget`, `Budget Duration`, `TPM Limit`, `RPM Limit`

## RPM / TPM：速率控制

**Budget 控花多少钱，RPM/TPM 控打得多快。**

| 限制 | 全称 | 含义 | 典型值 |
|---|---|---|---|
| **RPM** | Requests Per Minute | 每分钟请求次数上限 | 100 ～ 10,000 |
| **TPM** | Tokens Per Minute | 每分钟 token 总量上限（input + output） | 100k ～ 5M |

### 在哪设

在 **Team / Key / Internal User** 三个层级都能设 `rpm_limit` 和 `tpm_limit`，作用方式和 Budget 一样——**任一层触发就 reject**。

```yaml
# config.yaml 里给整个 proxy 设兜底默认
litellm_settings:
  default_team_settings:
    - team_id: "default-settings"
      max_budget: 100.0
      tpm_limit: 1000000
      rpm_limit: 600
```

```bash
# Team 级
curl -X POST http://proxy/team/new \
  -d '{"team_alias":"svc-a","max_budget":500,"tpm_limit":500000,"rpm_limit":300}'

# Key 级
curl -X POST http://proxy/key/generate \
  -d '{"team_id":"...","tpm_limit":100000,"rpm_limit":60}'
```

### RPM vs TPM 怎么选

- **RPM**：防止突发调用洪水（比如失控的 retry 循环）
- **TPM**：防止长上下文请求把配额一次性打空（一个 200k token 请求顶 200 个正常请求）
- **建议同时设**，经验公式：`TPM ≈ RPM × 平均每请求 token 数 × 2（buffer）`

### 和上游 Bedrock 配额的关系

⚠️ **LiteLLM 的 TPM 限的是"从客户端到 LiteLLM"**，上游 Bedrock 还有它自己的 account-level TPM 配额。LiteLLM TPM 设得比 Bedrock 配额大没用，请求到 Bedrock 还是会被 throttle。

**落地建议**：

```
所有 Team TPM 之和 ≤ Bedrock account TPM × 0.8（留 20% buffer 给突发）
```

### Per-Model RPM/TPM

如果想对某个具体模型限流（比如只限 Opus 不限 Sonnet），用 `model_rpm_limit` / `model_tpm_limit`：

```bash
curl -X POST http://proxy/team/new \
  -d '{
    "team_alias":"svc-a",
    "tpm_limit":1000000,
    "model_tpm_limit": {"claude-opus-4-7": 200000}
  }'
```

## Budget Reset 机制

### 基本规则

- `budget_duration` 设了才会 reset，**不设就是一次性预算**，花完 Key/Team/User 永久停用
- 取值格式：`"30s" / "30m" / "1h" / "1d" / "30d"`
- 每次创建时算出 `budget_reset_at`（下次重置时间）
- LiteLLM 后台有定时任务轮询，时间到就 `spend = 0` 并滚动 `budget_reset_at`

### Reset 时间对齐（v1.52.0+）

旧版本 `budget_reset_at = created_at + duration`，导致各 Team reset 时间散乱难对账。新版把 reset 对齐到**时区的自然日历边界**：

| `budget_duration` | 重置时刻 |
|---|---|
| `1d` | 每天 **00:00:00**（配置时区） |
| `7d` | 每周一 **00:00:00** |
| `30d` | 每月 **1 日 00:00:00** |
| `1h` | 每小时整点 |
| 其他（`30s`, `15m` 等） | 按 duration 滚动，不对齐 |

### 时区配置

默认 UTC，可在 `config.yaml` 里改：

```yaml
litellm_settings:
  max_budget: 100
  budget_duration: 30d
  timezone: "Asia/Shanghai"   # 任意 IANA 时区字符串
```

- 支持所有 IANA tz（`Asia/Shanghai`, `US/Eastern`, `Europe/London` 等）
- **自动处理夏令时**（DST 转换）
- 底层用 Python 的 `zoneinfo`

### 生产建议

1. **统一时区**：整个 proxy 用一个时区（推荐业务主时区），便于对账
2. **30d 对月初不对 30×24h**：要注意——"budget_duration=30d"在新版是**自然月**，2 月 28 号也会重置，不是整整 30 天
3. **测试用 30s/1m**：跑 E2E 时 duration 设小点好观察，上线前改回 `30d`

## 其他重要的坑

### 1. `soft_budget`：预警但不阻断

除了 `max_budget`（硬上限，超了就 reject），还有 `soft_budget`（软上限，超了发告警但仍然放行）。适合做**分级预警**：

```bash
curl -X POST http://proxy/key/generate \
  -d '{"soft_budget": 80, "max_budget": 100}'
```

搭配 `alerting` 配置（Slack / 飞书 webhook）推送告警：

```yaml
general_settings:
  alerting: ["slack"]
  alerting_threshold: 300
  alert_types: ["budget_alerts", "spend_reports"]
```

### 2. Budget 数据**必须持久化**

- Budget / Spend 数据都在 **Postgres**（`LiteLLM_VerificationToken`, `LiteLLM_TeamTable`, `LiteLLM_UserTable` 等表）
- RDS 挂了 = Budget 拦截失效（LiteLLM 会 fallback 放行），DB 一定要 Multi-AZ + 定期备份
- Valkey 只做**实时 spend 聚合同步**（多 pod 之间共享当前窗口的累计值），缓存挂了只会短时间限流不准，不会丢数据

### 3. Prometheus 监控 Remaining Budget

```yaml
litellm_settings:
  success_callback: ["prometheus"]
  failure_callback: ["prometheus"]
```

暴露的 metrics：

- `litellm_remaining_team_budget_metric{team_alias="..."}` — Team 剩余预算
- `litellm_spend_metric{api_key="..."}` — 单 Key 消费
- `litellm_request_total_by_api_key_v2` — 请求计数

Grafana 里做**剩余预算 < 10% 告警**，比单纯 Slack webhook 更可控。

### 4. 花超了的 HTTP 响应

触发预算或速率限制时 LiteLLM 返回：

```json
{
  "error": {
    "message": "Budget has been exceeded! Current cost: 101.23, Max budget: 100",
    "type": "auth_error",
    "code": 400
  }
}
```

**注意是 `400` 不是 `429`**（LiteLLM 把它归为 auth 错误，不是 rate limit）。客户端重试逻辑要能识别这个 message。

### 5. Admin UI 改了配额不会立刻生效的情况

Admin UI 改 Budget/TPM 是写 DB，但每个 LiteLLM Pod 内存里有个 **60s 的 cache**。改完要立即生效，去 Admin UI → Settings → **Flush Cache**，或重启 Pod。

### 6. 删除 Team / User 不会自动删 Key

- 删 Team 后，这个 Team 下的 Key 仍然存在且可用（但失去了 Team 预算约束）
- **操作顺序**：先 `/key/delete` 删光 Key，再删 Team/User；否则会有"孤儿 Key"绕过限制

### 7. Budget 和 Prompt Cache 叠加时的计费

- Prompt Cache 的**读/写 token** 也会计入 spend（按 Bedrock 定价的 cache read、write 价格）
- 不会因为"是 cache hit 就不扣预算"——Cache 省钱不是预算免单
- TPM 限额**只数进 LLM 的 tokens**，cache read 的 token 也算 input
