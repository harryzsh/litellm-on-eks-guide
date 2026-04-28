# LiteLLM on EKS — Deployment Guide

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Production-ready deployment guide for [LiteLLM Proxy](https://github.com/BerriAI/litellm) on AWS EKS, integrated with Bedrock (Claude), Valkey cache, CloudFront fronting, and Helm-driven lifecycle.

This is a field manual distilled from hands-on production deployment — covering the full path from a fresh EKS cluster to a running proxy with budget control, prompt caching, multi-account load balancing, and observability.

## 选型原则

本指南遵循以下原则，读者可按自身情况调整：

1. **Serverless 优先**：在满足性能需求的前提下，优先选择 Serverless 服务（ElastiCache Serverless Valkey、RDS Serverless v2 可选、EKS Fargate 可选等）。把能托管的都托管出去，减少容量规划和运维负担。
2. **不指定机型**：具体实例规格、节点数量请根据业务实际压测结果决定。本指南不做机型推荐，所有原文里的机型已替换为 `<INSTANCE_TYPE>` 等占位符。
3. **最小权限**：所有 IAM Policy 遵循最小权限原则，按需进一步收紧。
4. **Secrets 不落盘**：凭证通过 AWS Secrets Manager + Secrets Store CSI Driver 注入，不写入代码或 values.yaml。
5. **缓存层用 Valkey**：我们生产环境使用 ElastiCache Serverless Valkey（Redis 协议兼容，7.x+ 之后更优的开源许可）。所有文档中的 `redis://` / `rediss://` URL scheme、`REDIS_HOST` 等环境变量名是 LiteLLM 本身的配置契约，保留不动。

## 架构全景

```
用户
  │
  ▼
CloudFront (HTTPS)
  │  Distribution: <CLOUDFRONT_DISTRIBUTION_ID>
  │  域名: <YOUR_CLOUDFRONT_DOMAIN>
  ▼
VPC Origin（内网穿透，不走公网）
  │  Origin ID: <VPC_ORIGIN_ID>
  ▼
Internal ALB
  │  <INTERNAL_ALB_DNS>
  ▼
LiteLLM Pod × N（EKS namespace: litellm）
  ├──→ ElastiCache Serverless Valkey（缓存层，TLS）
  │    <VALKEY_ENDPOINT>:6379
  ├──→ RDS PostgreSQL（请求日志 / 用量追踪）
  │    <RDS_ENDPOINT>:5432/litellm
  ├──→ AWS Bedrock（模型推理）
  └──→ AWS Secrets Manager（统一密钥管理，via CSI Driver）
       litellm/db         → DATABASE_URL
       litellm/master-key → LITELLM_MASTER_KEY
```

## 目录

| # | 章节 | 内容 |
|---|---|---|
|  1 | [架构全景](docs/01-architecture.md) | 整体组件拓扑，数据面与控制面 |
|  2 | [前置条件](docs/02-prerequisites.md) | 工具、权限、前置依赖 |
|  3 | [EKS 集群配置](docs/03-eks-setup.md) | EKS 配置、ALB Controller、OIDC、子网标签 |
|  4 | [创建 Namespace 与 RDS 初始化](docs/04-namespace-rds.md) | Namespace、RDS 库/用户初始化 |
|  5 | [Bedrock 凭证配置](docs/05-bedrock-credentials.md) | IRSA + AKSK 两种 Bedrock 凭证方案对比与落地 |
|  6 | [Secrets Store CSI Driver](docs/06-secrets-csi.md) | Secrets Store CSI Driver 安装 |
|  7 | [SecretProviderClass 与 Secrets 创建](docs/07-secret-provider-class.md) | SecretProviderClass 与 Secrets Manager 集成 |
|  8 | [Valkey 缓存层](docs/08-valkey-cache.md) | ElastiCache Serverless Valkey 选型与连通 |
|  9 | [Helm 部署 LiteLLM](docs/09-helm-install.md) | Helm values、proxy_config、常见配置坑 |
| 10 | [CloudFront 配置](docs/10-cloudfront.md) | CloudFront + VPC Origin，内网 ALB 暴露 |
| 11 | [基础验证](docs/11-verification.md) | 基础连通性与 /health 验证 |
| 12 | [关键资源速查](docs/12-resource-reference.md) | Namespace 下所有资源速查表 |
| 13 | [模型管理](docs/13-model-management.md) | 模型接入、inference profile、region fallback |
| 14 | [Prompt Caching 策略](docs/14-prompt-caching.md) | Prompt caching 机制、叠加策略、cache_control 注入 |
| 15 | [Load Balancing 与多账号路由](docs/15-load-balancing.md) | Load balancing、多账号路由、retry/fallback |
| 16 | [Budget 管控与速率限制](docs/16-budget-rate-limit.md) | Budget、RPM、TPM 三层模型、Reset 时区 |
| 17 | [完整验收流程](docs/17-acceptance.md) | 从 Step 1 到 Step 10 的完整验收清单 |
| 18 | [运维与已知问题](docs/18-operations.md) | 升级、已知问题与 hotfix |


## 使用方式

1. 按章节顺序过一遍，每一章都有"前置"/"步骤"/"验证"三段式
2. 所有 `<PLACEHOLDER>` 需要你替换成实际值，常见清单：
   - `<EKS_CLUSTER_NAME>` — 你的 EKS 集群名
   - `<ACCOUNT_ID>` — 12 位 AWS 账号 ID
   - `<INTERNAL_ALB_DNS>` — Internal ALB 的 DNS
   - `<YOUR_CLOUDFRONT_DOMAIN>` — CloudFront domain
   - `<RDS_ENDPOINT>` / `<VALKEY_ENDPOINT>` — 数据层 endpoint
   - `<YOUR_MASTER_KEY>` — LiteLLM master key（建议 `openssl rand -hex 32`）
3. Terraform/CDK 的 IaC 模板我暂时没整理出来 — 欢迎 PR

## Contributing

Issues / PR 欢迎。尤其是：

- 新的 Bedrock 区域支持（ap-east-1、ap-southeast-2 等）
- Terraform / Pulumi 模板
- Helm chart values 的最小可运行示例
- 其他踩过的坑与解决方案

## License

MIT © 2026 — See [LICENSE](LICENSE).

## Acknowledgments

- [LiteLLM](https://github.com/BerriAI/litellm) by BerriAI
- [Secrets Store CSI Driver](https://secrets-store-csi-driver.sigs.k8s.io/) — AWS Provider
- AWS Bedrock Anthropic Claude series
