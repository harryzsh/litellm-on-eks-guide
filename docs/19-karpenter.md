# Karpenter 配置说明

本文档详细解释本仓库中 Karpenter 的部署方式、每个配置值的取舍、以及业务 pod
怎么挂上 Karpenter 节点。所有定义都在 `cdk/lib/cluster-stack.ts`，本文做一份
带「为什么」的对照阅读。

## 19.0 双层节点架构（一图概览）

```
┌──────────────────────────────────────────────────────────────────┐
│  Karpenter Nodes  ←──  动态、按需、随业务流量伸缩                 │
│  ─────────────────                                                │
│  EC2: m6i / m6a / c6i  (large / xlarge / 2xlarge)                │
│  AMI: AL2023 EKS-optimized (alias al2023@latest)                 │
│  容量类型: on-demand                                              │
│  跑这些 pod:                                                      │
│    • litellm-deployment × 2-10 (HPA 控制副本数)                   │
│    • 任何 nodeSelector: provisioned-by=karpenter 的业务负载       │
└──────────────────────────────────────────────────────────────────┘
                             ▲
                             │ Karpenter controller 创建/销毁
                             │ (SSM 解析 AMI + EC2 RunInstances)
                             │
┌──────────────────────────────────────────────────────────────────┐
│  Managed Node Group "system"  ←──  静态、永远 2 台、跑系统组件    │
│  ─────────────────────────                                        │
│  EC2: t3.medium × 2 (跨 1a + 1b, ~$60/月)                         │
│  AMI: EKS 默认 (AWS 自动滚动升级)                                 │
│  Taint: CriticalAddonsOnly:NoSchedule                            │
│  跑这些 pod (都对 CriticalAddonsOnly 做了 toleration):             │
│    • karpenter (controller 自身, 2 副本)                          │
│    • aws-load-balancer-controller                                │
│    • external-secrets                                            │
│    • metrics-server  (EKS Addon)                                 │
│    • coredns / kube-proxy / aws-node  (EKS managed addons)       │
└──────────────────────────────────────────────────────────────────┘
```

## 19.1 为什么用这种「双层」方式

### 问题：Karpenter 自己怎么跑起来？

Karpenter controller 跑在 K8s pod 里，pod 必须有 node 才能跑。但是 Karpenter 的
工作就是创建 node —— 所以**必须有先于 Karpenter 存在的节点来跑 Karpenter 自己**。

这是经典的鸡蛋问题。AWS 的解决方案是：先用 Managed Node Group 起最低限度的节点
（2 台），让所有"系统组件"跑在上面，再让 Karpenter 在这之上管理"业务节点"。

### 进一步的隔离：CriticalAddonsOnly taint

光让 system MNG 存在还不够。**业务 pod 不应该被调度到 system MNG 上**，原因：

1. **稳定性隔离**：system MNG 是 Karpenter 控制平面的"宿主"，业务 pod 抢资源
   会让 Karpenter controller 自己 OOM / 卡顿，整个集群伸缩瘫痪。
2. **成本可见性**：t3.medium 和 m6a.large 价格不同；业务 pod 跑在哪台节点上影响
   计费归属。
3. **生命周期不同**：业务 pod 要随流量频繁伸缩；system pod 应当稳定。

实现方式：

- **System MNG 加 taint**：`CriticalAddonsOnly:NoSchedule`
  → 没显式 toleration 的 pod 不会被调度过来
- **System 组件加 toleration**：karpenter / aws-lbc / external-secrets / metrics-server
  / EKS managed addons 都对 `CriticalAddonsOnly` 加 toleration，所以**只有它们**
  能在 system MNG 上跑
- **业务 pod 加 nodeSelector**：`provisioned-by: karpenter` 强制只调度到 Karpenter
  节点（参见 §19.6）

## 19.2 System Managed Node Group

CDK 代码（`cluster-stack.ts` §2）：

```typescript
const mng = cluster.addNodegroupCapacity('SystemNodegroup', {
  nodegroupName: `${props.projectName}-nodes`,
  instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
  minSize: 2,
  maxSize: 2,
  desiredSize: 2,
  diskSize: 20,
  capacityType: eks.CapacityType.ON_DEMAND,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  taints: [
    {
      key: 'CriticalAddonsOnly',
      value: 'true',
      effect: eks.TaintEffect.NO_SCHEDULE,
    },
  ],
  tags: {
    'auto-delete': 'no',
    Project: props.projectName,
    Name: `${props.projectName}-nodes`,
  },
});
```

| 字段 | 取值 | 为什么 |
|---|---|---|
| `instanceTypes` | `t3.medium` | 价格 ~$30/月（vs c6i.large $62）。系统组件 pod 加起来 mem ~500Mi、cpu ~50m，t3.medium 的 4GB / 2vCPU 完全够用 |
| `minSize=maxSize=desiredSize=2` | 固定 2 台 | 跨 2 个 AZ（1a + 1b），任意 AZ 全挂 system 组件还活；不需要伸缩，伸缩职责给 Karpenter |
| `diskSize` | 20 GB | 系统组件 image 总和 < 5GB，给 EBS gp3 留 4x buffer |
| `capacityType` | `ON_DEMAND` | system 组件不能被 spot 中断 ——controller 挂掉直接影响整个集群 |
| `subnets` | `PRIVATE_WITH_EGRESS` | system pod 不需要直接被外部访问，私有子网更安全 |
| **`taints: CriticalAddonsOnly:NoSchedule`** | — | **核心隔离机制**：让业务 pod 不能调度过来 |
| `tags['auto-delete']: 'no'` | — | 防资源清理工具误删（详见 §19.3 ASG 标签传播） |

为什么不用 `t4g.medium`（Graviton 版本）省钱？因为 system pod（Karpenter
controller、aws-lbc 等）**容器镜像不一定支持 arm64**，需要逐个验证；t3.medium
是无脑安全选择。

## 19.3 ASG 标签传播

EKS Managed Node Group 的 tags **不会自动传播到底层 Auto Scaling Group / EC2 实例**。
也就是说：

```
MNG Tags:                ASG Tags:               EC2 Tags:
auto-delete=no       →   (空)               →    (空)
```

这看起来没事，但如果你有按标签做资源筛选/保护的下游工具（资源清理脚本、成本归属、合规检查等），它们看到 ASG 和 EC2 上没标签 → 可能误判为"未保护资源"。

**修复方式**：用 AWS Custom Resource 在 ASG 层设标签，并设
`PropagateAtLaunch: true`：

```typescript
// 第一步：拿 ASG name (从 EKS describeNodegroup 返回值)
const asgName = tagAsg.getResponseField('nodegroup.resources.autoScalingGroups.0.name');

// 第二步：直接在 ASG 设 tag, propagate 到所有 EC2
new AwsCustomResource(this, 'WriteAsgPropagatedTag', {
  onCreate: {
    service: 'AutoScaling',
    action: 'createOrUpdateTags',
    parameters: {
      Tags: [{
        Key: 'auto-delete',
        Value: 'no',
        PropagateAtLaunch: true,        // ← 关键
        ResourceId: asgName,
        ResourceType: 'auto-scaling-group',
      }],
    },
    // ...
  },
});
```

`PropagateAtLaunch: true` 的效果：
- ASG 自身有这个 tag
- ASG 启动的每个 EC2 实例**也会有**这个 tag

→ 任何按 tag 查询资源的工具，在 MNG / ASG / EC2 任意一层都能命中。

## 19.4 EKS 集群本身的关键配置

```typescript
const cluster = new eks.Cluster(this, 'Cluster', {
  version: eks.KubernetesVersion.V1_33,
  defaultCapacity: 0,        // ← 关键
  endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
  authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
  // ...
});
```

| 字段 | 取值 | 为什么 |
|---|---|---|
| `defaultCapacity: 0` | 不创建默认 nodegroup | CDK 默认会帮你建一个 m5.large × 2 的 MNG。我们要自己定义 system MNG（带 taint），所以禁掉 |
| `authenticationMode: API_AND_CONFIG_MAP` | 双模式 | 兼容旧 aws-auth ConfigMap，同时启用新的 EKS Access Entry API（Karpenter node role 用 API 模式注册） |
| `endpointAccess: PUBLIC_AND_PRIVATE` | — | 让 kubectl 从公网能用、VPC 内 pod 也能调控制面 |

## 19.5 Karpenter 自身的部署

### 19.5.1 IAM：节点角色

Karpenter 会创建 EC2 实例，每台实例需要一个 IAM Role 才能作为 K8s 节点工作：

```typescript
const karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
  roleName: `${props.projectName}-karpenter-node`,
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
    iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
  ],
});

new iam.CfnInstanceProfile(this, 'KarpenterNodeInstanceProfile', {
  instanceProfileName: `${props.projectName}-karpenter-node`,
  roles: [karpenterNodeRole.roleName],
});

// EKS Access Entry，让节点能注册到集群
new eks.AccessEntry(this, 'KarpenterNodeAccessEntry', {
  cluster,
  principal: karpenterNodeRole.roleArn,
  accessEntryType: eks.AccessEntryType.EC2_LINUX,
  accessPolicies: [],
});
```

**4 个托管策略各司其职：**
- `AmazonEKSWorkerNodePolicy`: 节点能向 EKS API 报告状态（必需）
- `AmazonEKS_CNI_Policy`: VPC CNI 给 pod 分配 ENI/IP（必需）
- `AmazonEC2ContainerRegistryReadOnly`: 拉 ECR 镜像
- `AmazonSSMManagedInstanceCore`: SSM Session Manager，调试节点用（可选但强烈建议）

`AccessEntry` 是 EKS 1.30+ 新机制，**不需要手动改 aws-auth ConfigMap**
就能让节点注册。

### 19.5.2 IAM：Controller IRSA

Karpenter controller pod（不是 node）需要 IAM 权限调 EC2 / SSM / IAM
等 API。用 IRSA（IAM Roles for Service Accounts）：

```typescript
const karpenterControllerSa = cluster.addServiceAccount('KarpenterControllerSa', {
  name: 'karpenter',
  namespace: 'karpenter',
});
new iam.Policy(this, 'KarpenterControllerPolicy', {
  policyName: `${props.projectName}-karpenter-controller`,
  document: karpenterPolicyDoc,        // 来自 lib/policies/karpenter-controller-policy.json
  roles: [karpenterControllerSa.role],
});
```

`karpenter-controller-policy.json` 列了具体权限（约 30 条 EC2 + IAM + SSM 操作）。
关键能力：
- `ec2:RunInstances` — 起新节点
- `ec2:TerminateInstances`（限 tag karpenter.sh/discovery 的资源）— 终止节点
- `iam:PassRole`（限 Karpenter node role） — 把节点 role 交给 EC2
- `ssm:GetParameter` — 解析 EKS-optimized AMI ID（参见 §19.7.1）
- `pricing:GetProducts` — 选最便宜的实例族

### 19.5.3 集群 SG 标签

EC2NodeClass 通过 tag 选择子网和 SG（参见 §19.7）。子网标签
（`karpenter.sh/discovery=<cluster-name>`）在 NetworkStack 里就加了，
但 **EKS 集群 SG 是 EKS-managed，不是 CDK 创建的**，所以要用 Custom Resource 加：

```typescript
const tagClusterSg = new AwsCustomResource(this, 'TagClusterSgForKarpenter', {
  onCreate: {
    service: 'EC2',
    action: 'createTags',
    parameters: {
      Resources: [cluster.clusterSecurityGroupId],
      Tags: [{ Key: 'karpenter.sh/discovery', Value: props.clusterName }],
    },
    // ...
  },
});
```

没这一步 → EC2NodeClass `securityGroupSelectorTerms` 找不到 SG → 节点起来后
没法跟控制面通信 → 集群里死活看不到节点 → Karpenter 重试堆积。

### 19.5.4 Helm chart

```typescript
const karpenterChart = cluster.addHelmChart('Karpenter', {
  chart: 'karpenter',
  repository: 'oci://public.ecr.aws/karpenter',
  release: 'karpenter',
  version: '1.5.0',
  namespace: 'karpenter',
  createNamespace: true,
  values: {
    settings: {
      clusterName: props.clusterName,
      clusterEndpoint: cluster.clusterEndpoint,
      interruptionQueue: '',     // 没用 spot, 留空
    },
    serviceAccount: {
      create: false,             // SA 已经在 IRSA 那步建好了
      name: 'karpenter',
    },
    controller: {
      resources: {
        requests: { cpu: '200m', memory: '512Mi' },
        limits: { cpu: '1', memory: '1Gi' },
      },
    },
    tolerations: [
      { key: 'CriticalAddonsOnly', operator: 'Exists' },
    ],
  },
});
```

| 字段 | 值 | 为什么 |
|---|---|---|
| `version: 1.5.0` | Karpenter v1.5.0 | 兼容 EKS 1.28-1.33。**注意：当前我们集群已升 1.34**，参见 §19.11 |
| `settings.interruptionQueue: ''` | 空 | Spot 中断处理需要 SQS queue + EventBridge 规则；我们没用 spot 所以省了。等加 spot 时要补 |
| `serviceAccount.create: false` | — | SA 已经由 CDK 创建（带 IRSA role 注解）；让 Helm 创建会覆盖掉 IRSA |
| `controller.resources` | req 200m/512Mi, lim 1/1Gi | controller pod 在 idle 时只用 ~50m/100Mi，留 buffer 应对集群伸缩繁忙时 |
| `tolerations: CriticalAddonsOnly` | — | **必须有！** 让 controller 能在 system MNG 上调度（system MNG 有这个 taint）|

## 19.6 EC2NodeClass — Karpenter 用什么 AMI / 子网 / SG / IAM 起节点

```typescript
cluster.addManifest('Ec2NodeClass', {
  apiVersion: 'karpenter.k8s.aws/v1',
  kind: 'EC2NodeClass',
  metadata: { name: 'default' },
  spec: {
    amiFamily: 'AL2023',
    amiSelectorTerms: [{ alias: 'al2023@latest' }],
    role: props.karpenterNodeRoleName,
    subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
    securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
    tags: {
      'karpenter.sh/discovery': props.clusterName,
      'auto-delete': 'no',
    },
  },
});
```

逐项解释：

### `amiFamily: AL2023`

可选：`AL2`（旧），`AL2023`（新，推荐），`Bottlerocket`，`Windows2019/2022`，
`Custom`。

我们用 AL2023：
- AWS 主推（AL2 已 EOL 时间表）
- 默认更安全（SELinux enforcing、不可变 root fs）
- `dnf` 包管理（vs AL2 的 `yum`）
- kubelet 跟 K8s 版本绑定更紧

### `amiSelectorTerms: [{ alias: 'al2023@latest' }]`

这是 **Karpenter v1 的关键语法糖**。`alias` 格式是 `<family>@<version>`：

| 写法 | 行为 | 适合场景 |
|---|---|---|
| `al2023@latest` | 跟 EKS 控制面 K8s 版本走，永远拉最新 release 的 EKS-optimized AMI | 现在用这个 |
| `al2023@v20260512` | 钉死在 `v20260512` 这个 release tag，不会 drift | 想精确控制升级节奏 |
| `bottlerocket@latest` | 换 AMI family，行为类似 | 想试 Bottlerocket |

底层 Karpenter 帮你查 SSM 参数：
```
/aws/service/eks/optimized-ami/<cluster-version>/amazon-linux-2023/<arch>-standard/recommended/image_id
                                ↑
                        EKS 集群版本 (例如 1.33 / 1.34)
```

`@latest` 意味着两件事都会触发**全节点 drift（rolling 替换）**：
1. AWS 推送新 AMI（每周 1-2 次的 OS 补丁更新）
2. EKS 控制面升级 K8s minor 版本

> **Incident 2026-05-15 + 2026-05-17**：两次"litellm pod 卡死"事故都是 `@latest`
> 触发的非预期滚动 — 详细 root cause 分析见
> [`docs/18-operations.md`](./18-operations.md) 的事故时间线。
>
> 生产环境推荐改成 `al2023@<specific-release>`，把 AMI 升级跟 K8s 升级解耦。
> 当前仓库保留 `@latest` 是 trade-off：自动跟进安全补丁 vs 升级时点不可控。

### `role: props.karpenterNodeRoleName`

这就是 §19.5.1 创建的 `${projectName}-karpenter-node` IAM Role 的名字
（不是 ARN，注意）。Karpenter 创建 EC2 时把这个 role 关联给实例。

### `subnetSelectorTerms` / `securityGroupSelectorTerms`

```yaml
subnetSelectorTerms: [{ tags: { karpenter.sh/discovery: <cluster-name> } }]
securityGroupSelectorTerms: [{ tags: { karpenter.sh/discovery: <cluster-name> } }]
```

按 tag 选资源。需要事先打好 tag：
- 子网 tag：在 `lib/network-stack.ts` 里给所有 private subnet 打了
- SG tag：在 `cluster-stack.ts` 里用 Custom Resource 给 EKS cluster SG 打的（§19.5.3）

为什么按 tag 而不直接写 ID？为了让 NodePool 可移植 + 不被资源 ID 绑死。
新增子网/SG 时只要打上 tag 就自动被发现。

### `tags`

Karpenter 会把这些 tag 自动加到它创建的所有 EC2 实例上：
- `karpenter.sh/discovery`: 自动发现（让其它工具识别这是 Karpenter 节点）
- `auto-delete: no`: 跟 §19.3 同样的目的，防资源清理工具误删 Karpenter 节点

## 19.7 NodePool — Karpenter 在什么约束下选节点

```typescript
cluster.addManifest('NodePool', {
  apiVersion: 'karpenter.sh/v1',
  kind: 'NodePool',
  metadata: { name: 'default' },
  spec: {
    template: {
      metadata: { labels: { 'provisioned-by': 'karpenter' } },
      spec: {
        nodeClassRef: {
          group: 'karpenter.k8s.aws',
          kind: 'EC2NodeClass',
          name: 'default',
        },
        requirements: [
          { key: 'kubernetes.io/arch', operator: 'In', values: ['amd64'] },
          { key: 'kubernetes.io/os', operator: 'In', values: ['linux'] },
          { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
          { key: 'karpenter.k8s.aws/instance-family', operator: 'In', values: ['m6i', 'm6a', 'c6i'] },
          { key: 'karpenter.k8s.aws/instance-size', operator: 'In', values: ['large', 'xlarge', '2xlarge'] },
        ],
        expireAfter: '720h',
      },
    },
    limits: { cpu: 32, memory: '128Gi' },
    disruption: {
      consolidationPolicy: 'WhenEmptyOrUnderutilized',
      consolidateAfter: '30m',
    },
  },
});
```

### 19.7.1 `template.metadata.labels.provisioned-by: karpenter`

Karpenter 创建的节点都会有这个 label。**业务 pod 的 nodeSelector**
就靠它来 pin（参见 §19.8）。

### 19.7.2 `requirements` —— Karpenter 选实例的约束

每条 requirement 是一个"维度"，Karpenter 在所有维度的笛卡尔积里挑最便宜的：

| 维度 | 取值 | 为什么 |
|---|---|---|
| `kubernetes.io/arch` | `amd64` | litellm 镜像没验证 arm64，先安全选 x86 |
| `kubernetes.io/os` | `linux` | EKS 节点必须 linux |
| `karpenter.sh/capacity-type` | `on-demand` | 没装 spot 中断处理 (`interruptionQueue: ''`)，开 spot 节点被回收时 pod 强杀 |
| `karpenter.k8s.aws/instance-family` | `m6i, m6a, c6i` | 第 6 代，m 系列（CPU:Mem 1:4，给 litellm 这种 mem-driven 应用合适）+ c6i 兼容老配置 |
| `karpenter.k8s.aws/instance-size` | `large, xlarge, 2xlarge` | 设上限 2xlarge，防 Karpenter 选超大节点。litellm pod 单 mem 5Gi，2 个 pod 用 large 或 xlarge 即可 |

**实际选了什么**：当前 litellm pod 配置（cpu req 200m / mem req 5Gi），
Karpenter 算出来 `m6a.large`（4 vCPU / 8 GiB / $63/月）单价最低，跟 m6i.large
（$70/月）比省 10%。

为什么不开 m7i / Graviton（m6g/m7g）？
- **m7i**：可以加，但价格只比 m6i 贵约 5%、性能 +15%，对 litellm 这种 I/O 密集
  的应用收益不明显；保守先不加
- **Graviton**：要先验证 litellm 镜像支持 arm64（`docker manifest inspect`），
  当前镜像在私有 registry 拉不到 manifest，未确认 → 没加

### 19.7.3 `expireAfter: 720h`

每个 Karpenter 创建的节点最多活 30 天，到期 Karpenter 主动 drift 替换。

为什么要这个？**强制定期轮换**让节点不会跑超长时间——避免长期累积的内核
内存碎片、libc 漏洞窗口、kubelet 崩溃前兆等"长 uptime 才会暴露"的问题。

> 注意：跟 `al2023@latest` 叠加，等于"两个独立的滚动触发器"。如果改成
> `al2023@<release>` 钉版本，可以同时把 `expireAfter: Never` 关掉这个，
> 让滚动 100% 由 release 升级触发。当前两个都开 = 兜底。

### 19.7.4 `limits: cpu 32 / memory 128Gi`

这是 NodePool **总容量上限**（不是单节点）。Karpenter 创建的所有节点
CPU 总和不能超过 32 vCPU，mem 总和不能超过 128Gi。

为什么这两个数？
- 防"**HPA 失控扩 + 业务故障**"导致 Karpenter 起一堆机器烧钱
- 32 vCPU = 16 台 m6a.large，对当前业务量是 8 倍 burst 余量
- mem 128 GiB / cpu 32 = 1:4 比例，匹配 m 系列实例

**HPA maxReplicas: 10** + **每 pod request 200m cpu** = 2000m = 2 vCPU 总需求
（远小于 32 vCPU 上限），这个 limits 是**最后一道闸门**而不是日常约束。

### 19.7.5 `disruption.consolidationPolicy: WhenEmptyOrUnderutilized`

Karpenter 主动整理节点：
- `WhenEmpty`：节点上 pod 全没了再删（保守）
- `WhenEmptyOrUnderutilized`：发现"如果把这台节点上的 pod 重新调度到其它节点
  能放得下，且总成本更低，就删这台" ← 我们用的
- `Never`：从不主动整理

`WhenEmptyOrUnderutilized` 让 Karpenter 在流量低谷自动缩容（HPA 缩 pod 后，
某些节点变空 → Karpenter 删 → 省钱）。

### 19.7.6 `consolidateAfter: 30m`

发现节点"underutilized"后，**等 30 分钟才动**。防止短时流量波动触发
"删 → 又起 → 又删"的反复抖动。

> 用户体验：HPA 把 pod 从 4 缩到 2 后，会看到 4 个 NodeClaim 仍在 30 分钟内存活，
> 之后才被回收。这是正常现象，不是 bug。

## 19.8 业务 pod 怎么挂上 Karpenter 节点

业务 pod（比如 litellm）的 Deployment spec 里：

```yaml
spec:
  template:
    spec:
      nodeSelector:
        provisioned-by: karpenter        # ← 这个
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: litellm
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: litellm
```

调度逻辑：

1. K8s scheduler 看 pod 的 `nodeSelector: provisioned-by=karpenter`
2. 找现有节点 → 都是 system MNG（没这个 label）→ 找不到合适节点
3. Pod 状态变 `Pending` + `FailedScheduling`
4. **Karpenter 监听到 Pending pod**，看它的所有 affinity / taint / topologySpread / resource requests
5. Karpenter 决策：起一台新节点（按 NodePool 约束 + cheapest 算法）满足这个 pod
6. 新节点 ready，K8s scheduler 把 pod 调度过去

**topologySpreadConstraints 强制跨 AZ + 跨 host**（`DoNotSchedule`）：
- 第一个约束：每个 AZ 的 pod 数最多差 1 → 副本必须均匀分布在多 AZ
- 第二个约束：每个 host 的 pod 数最多差 1 → 副本不能堆在同一台节点

→ HPA 即使只是 2 副本，Karpenter 也会**起 2 台节点**（每 AZ 一台），
保证 AZ 全挂时仍有可用 pod。

## 19.9 高可用性是怎么做到的（保证「N 个 pod 跨 AZ」的 3 道独立保险）

§19.8 解释了 nodeSelector + topologySpread 的基本机制；本节深入：**到底有
哪些约束在协同工作，让 litellm 永远是「≥ N 个 pod、跨 AZ、跨节点」**？

### 19.9.1 实际现状（先看实测）

```
litellm-...-qd858  →  m6a.large  ip-10-0-10-217  us-east-1a  ✅
litellm-...-wnd87  →  m6a.large  ip-10-0-11-80   us-east-1b  ✅
```

2 个 pod 跨 us-east-1a + us-east-1b。这不是巧合，是 **3 道独立约束叠加** 的
必然结果。

### 19.9.2 三道保险

#### 保险 1: HPA `minReplicas: 2` —— 副本数下限

```yaml
# k8s/21-litellm-hpa-pdb.yaml
spec:
  minReplicas: 2          # 永远不会缩到 1
  maxReplicas: 10
```

- **没有这个**：HPA 在低流量时可能把 replicas 缩到 1 → 单点
- **有这个**：HPA 算出 desired ≥ 2，Deployment 始终 ≥ 2 个 pod

#### 保险 2: mem request 5Gi —— 数学上单节点装不下 2 pod

```
m6a.large 节点 allocatable mem:    7.06 GiB    (实测 7,229,880 Ki)
litellm pod request mem:           5 GiB
2 pod × 5 GiB = 10 GiB             >  7.06 GiB allocatable

→ scheduler 装箱时, 单台 m6a.large 物理上装不下 2 个 litellm pod
→ 必须有 ≥ 2 台节点
```

- **没有这个（比如 mem request 3Gi）**：单节点能装 2 pod (6Gi < 7.06Gi)
  → scheduler 倾向"把它们堆一起省节点"
- **有这个**：scheduler 必须等第 2 台节点存在才能放第 2 个 pod

> 这是「经济性手段反向使用」—— 利用 K8s scheduler 的 bin-packing 算法，
> **故意**把 request 设大到塞不下两个，从而强制 Karpenter 扩节点。

#### 保险 3: topologySpread `DoNotSchedule` —— 强制分散

```yaml
# k8s/03-deployment.yaml
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: DoNotSchedule         # 强制跨 AZ
    labelSelector:
      matchLabels:
        app: litellm
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: DoNotSchedule         # 强制跨节点
    labelSelector:
      matchLabels:
        app: litellm
```

- **没有这个**：仅靠保险 1+2，2 个 pod 可能都在同一个 AZ 的 2 台节点
  （满足跨节点但不跨 AZ）
- **有这个**：scheduler 拒绝这种摆放

### 19.9.3 三道保险的分工

| 想保证的目标 | 单独靠哪道？ |
|---|---|
| 副本数 ≥ 2 | 保险 1（HPA minReplicas） |
| 不堆同节点 | 保险 2（mem 装不下）+ 保险 3（host topologySpread） |
| 不堆同 AZ | **只能**保险 3（zone topologySpread） |
| 副本数随负载增长 | 保险 1（HPA scaleUp 到 maxReplicas=10） |

3 个共同协作 = 一定 ≥ 2 节点 + 一定跨 AZ。任何一条都不冗余。

### 19.9.4 maxSkew 到底怎么算

`maxSkew` 是 topologySpreadConstraints 的核心参数。**Skew** 的定义：

```
skew = max(每个 topology 域的 pod 数) - min(每个 topology 域的 pod 数)
```

`maxSkew: 1` = "这个差值最多 1，否则违反约束"。

#### 在你的集群跑实例（pods 全部带 `app: litellm` label）

按 `topologyKey: topology.kubernetes.io/zone` 算（domain 是 AZ）：

```
情况 A: 2 个 pod, 1 个在 1a, 1 个在 1b
        max=1, min=1
        skew = 1 - 1 = 0     ✅ ≤ 1  允许 (这是当前状态)

情况 B: 2 个 pod, 都在 1a (1b 是 0)
        max=2, min=0
        skew = 2 - 0 = 2     ❌ > 1  禁止 (DoNotSchedule)

情况 C: 3 个 pod, 2 个在 1a, 1 个在 1b
        max=2, min=1
        skew = 2 - 1 = 1     ✅ = 1  允许 (临界)

情况 D: 3 个 pod, 全在 1a
        max=3, min=0
        skew = 3 - 0 = 3     ❌  禁止

情况 E: 4 个 pod, 2 个在 1a, 2 个在 1b
        max=2, min=2
        skew = 2 - 2 = 0     ✅ 完全均匀

情况 F: 4 个 pod, 3 个在 1a, 1 个在 1b
        max=3, min=1
        skew = 3 - 1 = 2     ❌  禁止
```

#### 直觉理解

`maxSkew: 1` ≈ "**任意两个 AZ 的 pod 数差不能超过 1**"

- 它是**软均匀**约束，不是"必须等量"
- 偶数副本可以完全均匀（2→1+1, 4→2+2）
- 奇数副本必然差 1（3→2+1, 5→3+2）

### 19.9.5 `whenUnsatisfiable` 的两种行为

当 scheduler 算出来"放这个 pod 的话 skew 会超 maxSkew"时：

| 取值 | 行为 |
|---|---|
| `DoNotSchedule` | 不让调度，pod 进 Pending（→ 可能触发 Karpenter 扩节点） |
| `ScheduleAnyway` | 也"将就"调度上去（不阻止），但调度时偏向更均衡的位置 |

我们用 `DoNotSchedule` 是因为 HA 是硬要求，不能"将就"。

### 19.9.6 HPA 扩 1 个 pod 时 Karpenter 怎么响应（连锁反应）

假设 HPA 把 replicas 从 2 扩到 3：

#### Step 1：scheduler 试图塞第 3 个 pod 到现有节点

```
现有节点 1: m6a.large, AZ=1a, 已经跑 1 个 litellm pod
  allocatable mem 7.06 Gi
  减去 daemonset (~200 Mi)               ≈ 6.86 Gi 真正可用
  减去现有 litellm pod request 5 Gi      ≈ 1.86 Gi 剩余
  
  能塞下第 3 个 litellm pod (request 5 Gi) 吗?
  → 不能 (1.86 Gi < 5 Gi)

现有节点 2: m6a.large, AZ=1b, 已经跑 1 个 litellm pod
  → 同样剩 1.86 Gi, 装不下
```

→ 容量先把"省钱方案"堵死。

#### Step 2：scheduler 算 topologySpread

```
当前分布:  1a × 1 pod,  1b × 1 pod

新 pod 想放 1a 上 (假设有空间):  1a × 2, 1b × 1
  zone skew = 2 - 1 = 1            ✅ 不超 maxSkew=1
  
新 pod 想放 1b 上 (假设有空间):  对称, skew = 1, 也允许
  
新 pod 想堆在现有节点上 (假设有空间):
  hostname skew = 1 (新堆的节点变 2, 其它 1, 差 1)  → 边界但允许
  实际不会发生, 因为 Step 1 容量不够
```

→ topologySpread 本身不阻止"起新节点"，它只阻止"堆同节点"或"堆同 AZ 多个"。

#### Step 3：Karpenter 接管

```
T=0:    HPA 改 replicas: 2 → 3
T=0:    K8s 创建第 3 个 pod
T=1s:   scheduler 找不到节点 (容量+topology) → pod 进 Pending
        events: FailedScheduling, "0/N nodes are available"
T=5s:   Karpenter 监听到 Pending pod, 综合判断:
          - resource requests:  cpu 200m, mem 5Gi
          - nodeSelector:       provisioned-by=karpenter
          - topologySpread:     zone+hostname maxSkew=1
        Karpenter 决策:
          - 必须起新节点 (现有装不下)
          - NodePool 允许的实例族 (m6i/m6a/c6i) × 大小 (large/xlarge/2xlarge)
            中选最便宜 → m6a.large
          - AZ 选择: 1a 或 1b 都不影响 skew, 算法挑容量更紧的 AZ
T=10s:  Karpenter 调用 EC2 RunInstances
T=60s:  EC2 节点起来, 注册到 K8s
T=70s:  scheduler 把第 3 个 pod 调度上去
T=120s: 新 pod startupProbe 通过 → 1/1 Ready
```

#### Step 4：终态

```
2 节点 → 3 节点
2 pod  → 3 pod
月成本: $126 → $189 (+50%)
```

### 19.9.7 边界情况

#### Q1：HPA 扩到 4 pod 时？

zone topologySpread 算：
```
2+2 (1a × 2, 1b × 2): skew = 0           ✅ 最优
3+1 (1a × 3, 1b × 1): skew = 2  > 1      ❌ 违反
```

→ scheduler 必须 2+2 → Karpenter 起 2 个新节点（每 AZ 1 个），最终 4 节点。

#### Q2：HPA 缩回 2 pod 时？

```
PDB minAvailable: 1, Deployment maxUnavailable: 0
→ K8s 一次只 evict 1 个 pod (保证至少 N-1 个 pod 在跑)
→ 多余 pod 优先 evict 不均衡那个 AZ 的
→ 终态回到 2 pod (1a × 1, 1b × 1)

节点空着的会被 Karpenter consolidation 30 分钟后回收 (consolidateAfter: 30m)
→ 回到 2 节点
```

#### Q3：能不能用 m6a.xlarge 装 2 pod 省钱？

```
m6a.xlarge: 4 vCPU, 16 GiB
  装 2 pod (5 Gi × 2 = 10 Gi < 16 Gi)  → 物理上装得下
  月成本 ~$126, 跟 2 × m6a.large 同价

但 hostname maxSkew=1 阻止:
  2 pod 同节点 → host skew = 2  → 违反约束
  
→ Karpenter 即使想选 xlarge 省钱, hostname 约束也强制选 large × 2
```

**这是 hostname topologySpread 的额外作用**：不只防 SPOF，还防 Karpenter
"省钱省过头"把所有 pod 堆一台大节点。

#### Q4：Spot 节点回收时呢？

未配 SQS interruption queue（参见 §19.5.4），spot 节点被 AWS 回收时：
```
1. AWS 给 EC2 实例 metadata 写 "2 分钟后回收"
2. Karpenter 不知道 (没 queue)
3. 2 分钟后实例 terminate
4. Pod 被强杀 (没经过 graceful drain)
5. ReplicaSet 重新调度 → Karpenter 起新节点 → 但有 60-90s 业务感知中断
```

→ 当前 NodePool 强制 `on-demand`，避免这问题。要上 spot 的话需要先配
SQS + EventBridge interruption queue。

### 19.9.8 验证当前状态的命令

```bash
# 看实际 pod 分布 (NODE 列前缀 ip-10-0-1X-... 里的 X:
#   X=0 是 1a (private subnet 10.0.10.0/24)
#   X=1 是 1b (private subnet 10.0.11.0/24))
kubectl -n litellm get pods -o wide

# 看 NodeClaim 跨 AZ
kubectl get nodeclaim -o custom-columns=\
NAME:.metadata.name,\
TYPE:.metadata.labels.node\.kubernetes\.io/instance-type,\
ZONE:.metadata.labels.topology\.kubernetes\.io/zone,\
NODE:.status.nodeName

# 看 Deployment 的 topologySpreadConstraints (确认是 DoNotSchedule)
kubectl -n litellm get deploy litellm -o jsonpath='{.spec.template.spec.topologySpreadConstraints}' | jq

# 看 HPA 指标 + 副本数
kubectl -n litellm get hpa litellm
```

#### 故意压一下来验证（生产请慎用）

```bash
# 临时把 minReplicas 改成 1, 看是否会缩
kubectl -n litellm patch hpa litellm --type='json' \
  -p='[{"op":"replace","path":"/spec/minReplicas","value":1}]'

# 等 5 分钟 (HPA scaleDown stabilizationWindow=300s) → 应该缩到 1 pod
# 改回 2:
kubectl -n litellm patch hpa litellm --type='json' \
  -p='[{"op":"replace","path":"/spec/minReplicas","value":2}]'
# → HPA 会扩回 2, 同时 Karpenter 起新节点 (因为之前缩 pod 时 consolidation 已回收节点)
```

### 19.9.9 总结

```
HPA min=2  +  mem 5Gi 不够 1 节点装 2 pod  +  topologySpread DoNotSchedule × 2
= 任何时候 ≥ 2 个 m6a.large
= 跨 ≥ 2 个 AZ
= 不堆同节点
= 单节点挂 / 单 AZ 挂时仍有 1 个 pod 服务业务
```

成本：2 × m6a.large × $63/月 ≈ $126/月 —— 这是 HA 的明码价格。

## 19.10 资源/资源使用观测命令

```bash
# 看所有 Karpenter NodeClaim（包括过渡期未回收的）
kubectl get nodeclaim -o wide

# 看节点跑了什么 pod（含 daemonset）
kubectl describe node <node-name> | head -50

# 看哪些 pod 挂在 Karpenter 节点上
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>

# 看 NodePool 当前用了多少容量（vs limits）
kubectl describe nodepool default

# Karpenter controller 日志（drift / disruption / launch / terminate）
kubectl -n karpenter logs -l app.kubernetes.io/name=karpenter --tail=200 | \
  grep -iE 'drift|disrupt|launch|terminat'

# EC2NodeClass 当前解析出哪些 AMI（看是否跟 K8s 版本对齐）
kubectl get ec2nodeclass default -o jsonpath='{.status.amis[*].name}'

# 节点真实资源用量（需 metrics-server）
kubectl top node
kubectl top pod -A --sort-by=memory
```

## 19.11 升级与版本兼容

### 19.11.1 升级 EKS 控制面 K8s 版本

```bash
# 先升控制面（AWS 自动滚动 system MNG 的 AMI 跟随）
aws eks update-cluster-version \
  --name <cluster-name> \
  --kubernetes-version 1.34 \
  --region us-east-1

# 等控制面 status: ACTIVE
aws eks describe-cluster --name <cluster-name> --query 'cluster.status'
```

控制面升级后会发生：
1. SSM 参数 `/aws/service/eks/optimized-ami/1.34/...` 更新
2. **EC2NodeClass.status.amis 变成 1.34 的 AMI**
3. Karpenter 比对 NodeClaim 当前 AMI ≠ 解析出的最新 AMI → 标记 `Drifted: True`
4. Karpenter 按 NodePool `disruption.budgets` 滚动替换所有 Karpenter 节点

System MNG 的升级是 EKS 管的，需要单独命令：
```bash
aws eks update-nodegroup-version \
  --cluster-name <cluster-name> \
  --nodegroup-name <projectName>-nodes \
  --region us-east-1
```

### 19.11.2 升级 Karpenter controller

Karpenter compatibility matrix：[https://karpenter.sh/docs/upgrading/compatibility/](https://karpenter.sh/docs/upgrading/compatibility/)

| Karpenter | 兼容 K8s |
|---|---|
| v1.5.x | 1.28 - 1.33 |
| v1.6.x | 1.29 - 1.34 |
| v1.7.x | 1.30 - 1.34 |

升级方式：改 `cluster-stack.ts` 里 `karpenterChart.version` 后 `cdk deploy`，
或临时手动 helm upgrade（注意先看 release notes 有没有 CRD 变更）。

### 19.11.3 控制 AMI 滚动节奏

如果想从 `@latest` 改成"我自己控制何时升 AMI"：

```typescript
// cluster-stack.ts 改:
amiSelectorTerms: [{ alias: 'al2023@v20260512' }],
```

效果：
- AWS 推新 AMI 时**不再自动 drift**
- 升级窗口你自己定：临时改成 `@latest` 触发滚动 → 完成后改回新的固定 release

## 19.12 当前的取舍清单（已知 trade-off）

按"已知 + 当前选择 + 未来可能改"列：

| 取舍点 | 当前 | 备选 | 何时该改 |
|---|---|---|---|
| AMI 滚动策略 | `al2023@latest` 自动跟进 | `al2023@<release>` 钉版本 | 想要业务高峰窗口期不滚节点 |
| Spot 实例 | 不用（`on-demand` only） | 加 `spot` + 配 SQS interruption queue | 月成本超 $200 想省 60% |
| Graviton (arm64) | 不用 | `m7g/m8g`（`@latest` 时控制面也得跟得上） | 验证 litellm 镜像支持 arm64 后 |
| 实例族 | m6i / m6a / c6i (6 代) | 加 m7i / m8g (7-8 代) | 第 7-8 代价格趋稳后 |
| `expireAfter` | 30 天硬轮换 | `Never` 或 `90d` | 钉了 AMI 版本之后可以延长 |
| Karpenter 版本 | v1.5.0（不官宣兼容 1.34，但实测能用） | 升 v1.6.x 跟齐 1.34 | 业务平稳时升 |

## 19.13 故障排查 cheatsheet

| 现象 | 可能原因 | 怎么验证 / 修 |
|---|---|---|
| Pod 一直 Pending，Karpenter 不动 | NodeClaim 没创建 | `kubectl get nodeclaim` + 看 Karpenter 日志 `controller=disruption` 日志 |
| NodeClaim 创建但节点不 Ready | SG 标签缺失，节点联不上控制面 | 看 EC2 SG 是否有 `karpenter.sh/discovery=<cluster>` |
| 业务 pod 调度到 system MNG | 业务 pod 没加 `nodeSelector: provisioned-by=karpenter` | 加上 |
| system 组件调度到 Karpenter 节点 | 没加 `tolerations: CriticalAddonsOnly` | 在组件 Helm values 里加上 |
| Karpenter 起的节点立刻又被替换 | Drift 被持续触发（AMI alias 变化 / NodePool 变化） | 看 NodeClaim `Drifted` 列；`kubectl describe nodeclaim` 看 reason |
| 节点过期立刻被替换但没 drain | 没设 PodDisruptionBudget | 给关键 Deployment 加 PDB（litellm 已经有 `minAvailable: 1`） |
| Karpenter 报错 "version not compatible" | controller 版本跟 K8s 版本不匹配 | 看 §19.11.2 升级 Karpenter |

## 相关文档

- [`01-architecture.md`](./01-architecture.md) — 整体架构
- [`03-eks-setup.md`](./03-eks-setup.md) — EKS 集群与基础组件部署
- [`18-operations.md`](./18-operations.md) — 运维手册（含具体事故 root cause）
- 上游：[Karpenter 官方文档](https://karpenter.sh/docs/)
- 上游：[EKS 用户指南 - Karpenter](https://docs.aws.amazon.com/eks/latest/userguide/karpenter.html)
