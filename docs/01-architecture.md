# 架构全景

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
LiteLLM Pod × 2（EKS namespace: litellm）
  ├──→ ElastiCache Serverless Valkey（缓存层，TLS）
  │    <VALKEY_ENDPOINT>:6379
  ├──→ RDS PostgreSQL（请求日志 / 用量追踪）
  │    <RDS_ENDPOINT>:5432/litellm
  ├──→ AWS Bedrock（模型推理）
  └──→ AWS Secrets Manager（secrets 统一管理，via CSI Driver）
       litellm/db         → DATABASE_URL
       litellm/master-key → LITELLM_MASTER_KEY
```

```
┌─────────────┐  ┌─────────────┐
│ Claude Code  │  │  OpenClaw   │
└──────┬───────┘  └──────┬──────┘
       │ OpenAI API       │
       └────────┬─────────┘
                ▼
        ┌───────────────┐
        │   ALB / NLB   │
        └───────┬───────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│LiteLLM │ │LiteLLM │ │LiteLLM │  ← 多实例（ECS/EKS）
│  #1    │ │  #2    │ │  #3    │
└───┬────┘ └───┬────┘ └───┬────┘
    │          │          │
    ├──────────┼──────────┤
    ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐
│ Valkey  │ │Postgres│ │  S3    │
│(HA)    │ │(RDS)   │ │(Logs)  │
└────────┘ └────────┘ └────────┘
    │
    └──── Rate Limit 同步
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────────┐┌────────────┐┌────────────┐
│ Bedrock    ││ Bedrock    ││ Bedrock    │
│ us-east-1  ││ us-west-2  ││ eu-west-1  │  ← 多 Region HA
│ (AKSK-1)   ││ (AKSK-2)   ││ (AKSK-3)   │
└────────────┘└────────────┘└────────────┘
```
