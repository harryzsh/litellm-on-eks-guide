# LiteLLM CDK — One-shot deployment of LiteLLM on EKS

A CDK (TypeScript) port of the proven LiteLLM-on-EKS stack from
`litellm-best-practice`. Deploys a complete production-ready LiteLLM
proxy in one `cdk deploy` command:

- **VPC** (10.0.0.0/16, 2 AZ, 1 NAT)
- **EKS** (1.33) with managed nodegroup (system nodes) + Karpenter (workload nodes)
- **RDS Postgres** (16.4, Multi-AZ, daily backup, 30-day PITR)
- **ElastiCache Redis** (7.1, Multi-AZ, primary + replica)
- **S3** logs bucket with lifecycle (30d→IA, 90d→Glacier, 365d→delete)
- **Secrets Manager** for LiteLLM master key + Bedrock AKSK
- **Helm** charts: external-secrets, aws-load-balancer-controller, karpenter
- **k8s** manifests: namespace, ConfigMap, Deployment, Service, Ingress (internal ALB), HPA, PDB, EC2NodeClass, NodePool

Excluded vs source repo: kiro-gateway, identity-guard plugin, CloudFront. Bedrock access uses static AKSK_1/AKSK_2 — Karpenter EC2NodeClass and MNG ASG both carry `auto-delete=no` to prevent SpringClean cleanup.

## Prerequisites

- AWS CLI configured with admin credentials in target account
- Node.js 20+ (`node --version`)
- AWS CDK CLI (`npm install -g aws-cdk` or use the local one)
- `kubectl` (any version 1.30+ works for inspecting after deploy)

## Bootstrap (first time per account/region)

```bash
export AWS_REGION=us-east-1   # or your region
cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION
```

## Deploy

```bash
npm install
npm run synth          # sanity check
npm run deploy         # ~30–40 minutes (EKS is the bottleneck)
```

Three stacks deploy in order:

1. `litellm-Network` (VPC) — ~2 min
2. `litellm-Data` (RDS / Redis / S3 / Secret) — ~10 min (RDS is slow)
3. `litellm-Cluster` (EKS / IAM / Helm / manifests) — ~25 min

## Post-deploy: fill the Bedrock AKSK placeholders

CDK creates the `litellm/config` secret with `CHANGE_ME` placeholders for the four Bedrock keys. LiteLLM pods will start but Bedrock calls will fail until you fill these.

```bash
SECRET_NAME=litellm/config
CURRENT=$(aws secretsmanager get-secret-value --secret-id $SECRET_NAME --query SecretString --output text)

# Patch in your real AKSK without losing the auto-generated master key:
echo "$CURRENT" | jq \
  --arg ak1 "AKIA…" \
  --arg sk1 "…" \
  --arg ak2 "AKIA…" \
  --arg sk2 "…" \
  '.AWS_ACCESS_KEY_ID_1 = $ak1
   | .AWS_SECRET_ACCESS_KEY_1 = $sk1
   | .AWS_ACCESS_KEY_ID_2 = $ak2
   | .AWS_SECRET_ACCESS_KEY_2 = $sk2' | \
  xargs -0 -I {} aws secretsmanager update-secret --secret-id $SECRET_NAME --secret-string "{}"
```

External Secrets Operator picks up changes within `refreshInterval: 1h`. Force an immediate refresh:

```bash
kubectl annotate externalsecret litellm-secrets -n litellm \
  force-sync=$(date +%s) --overwrite
kubectl rollout restart deployment/litellm -n litellm
```

## Verify

```bash
# Update kubeconfig
$(aws cloudformation describe-stacks --stack-name litellm-Cluster \
  --query "Stacks[0].Outputs[?OutputKey=='UpdateKubeconfigCommand'].OutputValue" --output text)

kubectl get nodes                              # 2 t3.medium MNG nodes
kubectl get pods -A                            # all Running
kubectl get ingress -n litellm                 # ALB DNS appears within ~3 min
kubectl get nodepool,ec2nodeclass              # both Ready

# Hit the ALB (internal, must be in VPC or via bastion)
ALB=$(kubectl get ingress -n litellm litellm -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
curl http://$ALB/health/readiness
```

When Karpenter spins up new nodes (after `kubectl scale deployment litellm --replicas=4`):

```bash
kubectl get nodeclaim -w
kubectl logs -n karpenter -l app.kubernetes.io/name=karpenter -f
```

## Configuration via cdk.json context

Defaults can be overridden:

```bash
cdk deploy --context clusterName=my-cluster
cdk deploy --context litellmImage=docker.litellm.ai/berriai/litellm:v1.84.0
```

## Tear down

```bash
npm run destroy
```

The S3 logs bucket and RDS instance use `RETAIN` / `SNAPSHOT` removal policies so data is preserved. Manual cleanup if you want them gone:

```bash
# Empty + delete the logs bucket
aws s3 rm s3://litellm-logs-$ACCOUNT-$REGION --recursive
aws s3 rb s3://litellm-logs-$ACCOUNT-$REGION

# Delete the final RDS snapshot
aws rds delete-db-snapshot --db-snapshot-identifier <snapshot-id>
```

## Architecture notes

- **MNG ASG `auto-delete=no` propagated tag** — applied via `AwsCustomResource` because EKS doesn't propagate nodegroup-level tags down to the ASG. Without this, SpringClean (or any tag-driven cleanup) will stop your nodes (real incident on 2026-05-14, fixed by this CDK).
- **Cluster SG `karpenter.sh/discovery` tag** — applied via `AwsCustomResource` because the cluster SG is created by EKS and not owned by CDK.
- **Karpenter pods stay on MNG** — Karpenter chart values include the `CriticalAddonsOnly` toleration; the chart's built-in nodeAffinity prevents Karpenter from running on Karpenter-provisioned nodes (anti-self-eviction).
- **DATABASE_URL is templated by ESO** — the litellm secret never contains the RDS password directly. ExternalSecret pulls both `litellm/config` and `litellm/rds-master`, then templates the URL at sync time. Rotating the RDS password just works.
- **No CloudFront / TLS** — internal ALB only. Add CloudFront/ACM/Route53 if you need public exposure.

## Troubleshooting

**Deploy hangs at karpenter helm chart**: 7-minute timeout on first install is normal — the OCI registry can be slow. If it fails, re-run `cdk deploy`.

**Ingress stuck without ALB DNS**: aws-lbc takes ~2 minutes to fully reconcile after the helm chart finishes. Check `kubectl logs -n kube-system deployment/aws-load-balancer-controller`.

**LiteLLM pods CrashLoopBackOff with `Bedrock: invalid credentials`**: AKSK_1/AKSK_2 in Secrets Manager still placeholder. Fill them, then `kubectl rollout restart deployment/litellm -n litellm`.

**`cdk destroy` fails on EKS**: VPC has lingering ENIs from leftover Karpenter nodes. Run `kubectl delete nodepool default` and wait 5 minutes before retrying.
