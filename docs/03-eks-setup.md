# EKS 集群配置

### 3.1 更新 kubeconfig

```
aws eks update-kubeconfig --name <EKS_CLUSTER_NAME> --region us-east-1
kubectl get nodes  # 验证连通性
```

### 3.2 安装 AWS Load Balancer Controller（如未安装）

```
# 创建 IAM Policy
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

# 创建 ServiceAccount
eksctl create iamserviceaccount \
  --cluster <EKS_CLUSTER_NAME> \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve \
  --region us-east-1

# 安装 Controller
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=<EKS_CLUSTER_NAME> \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```
