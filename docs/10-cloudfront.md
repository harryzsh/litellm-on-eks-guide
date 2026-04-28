# CloudFront 配置

### 10.1 获取 ALB ARN

```
ALB_ARN=$(aws elbv2 describe-load-balancers --region us-east-1 \
  --query "LoadBalancers[?contains(DNSName,'litellm')].LoadBalancerArn" \
  --output text)
echo "ALB ARN: ${ALB_ARN}"
```

### 10.2 创建 VPC Origin

```
aws cloudfront create-vpc-origin \
  --vpc-origin-endpoint-config '{
    "Name": "litellm-internal-alb",
    "Arn": "'${ALB_ARN}'",
    "HTTPPort": 80,
    "HTTPSPort": 443,
    "OriginProtocolPolicy": "http-only"
  }'
```

### 10.3 创建 Distribution

```
ALB_DNS=$(aws elbv2 describe-load-balancers --region us-east-1 \
  --query "LoadBalancers[?contains(DNSName,'litellm')].DNSName" \
  --output text)

aws cloudfront create-distribution \
  --distribution-config '{
    "Origins": {
      "Items": [{
        "Id": "litellm-origin",
        "DomainName": "'${ALB_DNS}'",
        "VpcOriginConfig": {
          "VPCOriginId": "<VPC_ORIGIN_ID>",
          "OriginReadTimeout": 60,
          "OriginKeepaliveTimeout": 5
        }
      }],
      "Quantity": 1
    },
    "DefaultCacheBehavior": {
      "ViewerProtocolPolicy": "redirect-to-https",
      "AllowedMethods": {"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],"Quantity":7},
      "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    },
    "Enabled": true,
    "CallerReference": "litellm-'$(date +%s)'"
  }'
```

如果你发现了 CloudFront VPC Origin redirect 到 ALB 内部地址 比如现象： 访问 CloudFront URL 时，浏览器被 redirect 到 ALB 内部地址（如 http://internal-k8s-litellm-...elb.amazonaws.com/ui/login/），页面无法访问。

触发条件： 访问不带 trailing slash 的路径，如 /ui/login、/ui

根因链路：

>   1. 用户访问 https://cloudfront-domain/ui/login

>   2. CloudFront 将请求转发给 VPC Origin（internal ALB）

>   3. 如果 Origin Request Policy 是 AllViewerExceptHostHeader，CloudFront 不会把 Host: cloudfront-domain 转发给

>   ALB，ALB/后端收到的 Host 是 ALB 自己的内部域名

>   4. LiteLLM 后端（uvicorn）发现 /ui/login 缺少 trailing slash，自动做 307 redirect 到 /ui/login/

>   5. uvicorn 用收到的 Host header 拼接 redirect URL → http://internal-k8s-litellm-...elb.amazonaws.com/ui/login/

>   6. 浏览器跟随 redirect 跳到 ALB 内部地址 → 无法访问

 为什么 `/ui/` 正常： 带了 trailing slash 的路径不触发 307 redirect，直接返回 200，所以没问题。用户在登录页面操作时，应用内部跳转到 /ui/login（不带 slash）才暴露问题。

**修复**： Origin Request Policy 改为 `Managed-AllViewer`（ID: 216adef6-5c7f-47e4-b989-5492eafa07d3），确保 Host header 被转发，uvicorn 生成的 redirect URL 就会用 CloudFront 域名。
