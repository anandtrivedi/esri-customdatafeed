# AWS Deployment - Simple Guide

Deploy your ArcGIS Custom Data Feed to AWS in 3 steps.

## Option 1: AWS App Runner (Easiest - 10 minutes)

### Step 1: Prepare Docker Image

```bash
# Build image
docker build -t arcgis-datafeed .

# Tag for ECR (replace ACCOUNT_ID and REGION)
docker tag arcgis-datafeed:latest ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/arcgis-datafeed:latest
```

### Step 2: Push to ECR

```bash
# Create ECR repository
aws ecr create-repository --repository-name arcgis-datafeed --region us-west-2

# Login to ECR
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com

# Push
docker push ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/arcgis-datafeed:latest
```

### Step 3: Deploy with App Runner

```bash
# Create App Runner service
aws apprunner create-service \
  --service-name arcgis-datafeed \
  --source-configuration '{
    "ImageRepository": {
      "ImageIdentifier": "ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/arcgis-datafeed:latest",
      "ImageRepositoryType": "ECR",
      "ImageConfiguration": {
        "Port": "5000",
        "RuntimeEnvironmentVariables": {
          "DATABRICKS_SERVER_HOSTNAME": "your-workspace.cloud.databricks.com",
          "DATABRICKS_HTTP_PATH": "/sql/1.0/warehouses/your-id",
          "DATABRICKS_ACCESS_TOKEN": "your-token"
        }
      }
    },
    "AutoDeploymentsEnabled": false
  }' \
  --instance-configuration '{
    "Cpu": "1 vCPU",
    "Memory": "2 GB"
  }'
```

**Result:** You get a URL like: `https://xyz123.us-west-2.awsapprunner.com`

---

## Option 2: AWS ECS Fargate (Production - 20 minutes)

### 1. Create Task Definition

Create `ecs-task-definition.json`:

```json
{
  "family": "arcgis-datafeed",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "datafeed",
      "image": "ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/arcgis-datafeed:latest",
      "portMappings": [{"containerPort": 5000, "protocol": "tcp"}],
      "environment": [
        {"name": "FLASK_DEBUG", "value": "False"}
      ],
      "secrets": [
        {
          "name": "DATABRICKS_SERVER_HOSTNAME",
          "valueFrom": "arn:aws:secretsmanager:us-west-2:ACCOUNT:secret:databricks/hostname"
        },
        {
          "name": "DATABRICKS_HTTP_PATH",
          "valueFrom": "arn:aws:secretsmanager:us-west-2:ACCOUNT:secret:databricks/http-path"
        },
        {
          "name": "DATABRICKS_ACCESS_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:us-west-2:ACCOUNT:secret:databricks/token"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/arcgis-datafeed",
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

### 2. Store Secrets

```bash
# Store Databricks credentials in Secrets Manager
aws secretsmanager create-secret \
  --name databricks/hostname \
  --secret-string "your-workspace.cloud.databricks.com"

aws secretsmanager create-secret \
  --name databricks/http-path \
  --secret-string "/sql/1.0/warehouses/your-id"

aws secretsmanager create-secret \
  --name databricks/token \
  --secret-string "your-personal-access-token"
```

### 3. Deploy to ECS

```bash
# Create log group
aws logs create-log-group --log-group-name /ecs/arcgis-datafeed

# Register task definition
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json

# Create ECS cluster
aws ecs create-cluster --cluster-name arcgis-cluster

# Create service with load balancer
aws ecs create-service \
  --cluster arcgis-cluster \
  --service-name arcgis-datafeed \
  --task-definition arcgis-datafeed \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=datafeed,containerPort=5000"
```

### 4. Set Up Load Balancer

```bash
# Create Application Load Balancer
aws elbv2 create-load-balancer \
  --name arcgis-datafeed-alb \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx \
  --scheme internet-facing

# Create target group
aws elbv2 create-target-group \
  --name arcgis-datafeed-tg \
  --protocol HTTP \
  --port 5000 \
  --vpc-id vpc-xxx \
  --target-type ip \
  --health-check-path /health

# Create listener
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:elasticloadbalancing:... \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...
```

**Result:** You get a URL like: `http://arcgis-datafeed-alb-123456.us-west-2.elb.amazonaws.com`

---

## Option 3: Simple EC2 (Quick Test - 15 minutes)

### 1. Launch EC2 Instance

```bash
# Launch Ubuntu instance
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.medium \
  --key-name your-key-pair \
  --security-groups default \
  --user-data file://user-data.sh
```

Create `user-data.sh`:

```bash
#!/bin/bash
apt-get update
apt-get install -y python3 python3-pip git

# Clone repo
cd /home/ubuntu
git clone https://github.com/anandtrivedi/esri-customdatafeed.git
cd esri-customdatafeed

# Install dependencies
pip3 install flask python-dotenv

# Create .env file
cat > .env << EOF
DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-id
DATABRICKS_ACCESS_TOKEN=your-token
EOF

# Start server
nohup python3 src/data_feed_provider.py > server.log 2>&1 &
```

### 2. Configure Security Group

```bash
# Allow HTTP traffic
aws ec2 authorize-security-group-ingress \
  --group-id sg-xxx \
  --protocol tcp \
  --port 5000 \
  --cidr 0.0.0.0/0
```

**Result:** Access at `http://YOUR_EC2_IP:5000`

---

## Your Endpoint URL

After deployment, your endpoint will be:

### For ArcGIS Pro:
```
https://your-domain.com/query?table_name=catalog.schema.table&geometry_column=geom
```

### For ArcGIS JavaScript API:
```javascript
const layer = new FeatureLayer({
  url: "https://your-domain.com/query?table_name=catalog.schema.table"
});
```

---

## Quick Cost Estimate

| Option | Monthly Cost | Best For |
|--------|-------------|----------|
| **App Runner** | ~$25-50 | Quick start, low traffic |
| **ECS Fargate** | ~$50-100 | Production, scalable |
| **EC2 t3.medium** | ~$30 | Simple, predictable |

---

## Testing Your Deployment

Once deployed, test:

```bash
# Health check
curl https://your-url.com/health

# Query endpoint
curl "https://your-url.com/query?table_name=your.table&f=json"
```

---

## Next: Add to ArcGIS Pro

1. Open ArcGIS Pro
2. Add Data → Data from Path
3. Enter: `https://your-url.com/query?table_name=your.table`
4. Done!

See **ARCGIS_TESTING.md** for complete ArcGIS integration steps.
