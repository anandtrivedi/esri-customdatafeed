# Deployment Guide

Guide for deploying the ArcGIS Custom Data Feed for Databricks to production environments.

## Table of Contents

1. [Docker Deployment](#docker-deployment)
2. [Cloud Deployments](#cloud-deployments)
3. [Security Configuration](#security-configuration)
4. [Performance Optimization](#performance-optimization)
5. [Monitoring](#monitoring)

---

## Docker Deployment

### Building the Image

```bash
# Build the Docker image
docker build -t arcgis-databricks-feed:latest .

# Test locally
docker run -p 5000:5000 \
  -e DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com \
  -e DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-id \
  -e DATABRICKS_ACCESS_TOKEN=your-token \
  arcgis-databricks-feed:latest
```

### Using Docker Compose

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

### Docker Production Configuration

Create a `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  datafeed:
    build: .
    image: arcgis-databricks-feed:latest
    container_name: arcgis-datafeed-prod
    ports:
      - "5000:5000"
    environment:
      - DATABRICKS_SERVER_HOSTNAME=${DATABRICKS_SERVER_HOSTNAME}
      - DATABRICKS_HTTP_PATH=${DATABRICKS_HTTP_PATH}
      - DATABRICKS_ACCESS_TOKEN=${DATABRICKS_ACCESS_TOKEN}
      - FLASK_DEBUG=False
    env_file:
      - .env.production
    restart: always
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - prod-network

  nginx:
    image: nginx:alpine
    container_name: nginx-proxy
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - datafeed
    restart: always
    networks:
      - prod-network

networks:
  prod-network:
    driver: bridge
```

### NGINX Reverse Proxy Configuration

Create `nginx.conf`:

```nginx
events {
    worker_connections 1024;
}

http {
    upstream datafeed {
        server datafeed:5000;
    }

    # HTTP to HTTPS redirect
    server {
        listen 80;
        server_name your-domain.com;
        return 301 https://$server_name$request_uri;
    }

    # HTTPS server
    server {
        listen 443 ssl http2;
        server_name your-domain.com;

        ssl_certificate /etc/nginx/ssl/cert.pem;
        ssl_certificate_key /etc/nginx/ssl/key.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # Security headers
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        location / {
            proxy_pass http://datafeed;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Timeouts
            proxy_connect_timeout 300s;
            proxy_send_timeout 300s;
            proxy_read_timeout 300s;

            # CORS headers (if needed)
            add_header Access-Control-Allow-Origin "*" always;
            add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
        }

        # Health check endpoint
        location /health {
            proxy_pass http://datafeed/health;
            access_log off;
        }
    }
}
```

---

## Cloud Deployments

### AWS Deployment (ECS)

1. **Create ECR Repository**:
```bash
aws ecr create-repository --repository-name arcgis-databricks-feed

# Authenticate Docker to ECR
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin \
  <account-id>.dkr.ecr.us-west-2.amazonaws.com
```

2. **Build and Push Image**:
```bash
# Tag image
docker tag arcgis-databricks-feed:latest \
  <account-id>.dkr.ecr.us-west-2.amazonaws.com/arcgis-databricks-feed:latest

# Push to ECR
docker push <account-id>.dkr.ecr.us-west-2.amazonaws.com/arcgis-databricks-feed:latest
```

3. **Create ECS Task Definition** (`task-definition.json`):
```json
{
  "family": "arcgis-databricks-feed",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    {
      "name": "datafeed",
      "image": "<account-id>.dkr.ecr.us-west-2.amazonaws.com/arcgis-databricks-feed:latest",
      "portMappings": [
        {
          "containerPort": 5000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "FLASK_DEBUG",
          "value": "False"
        }
      ],
      "secrets": [
        {
          "name": "DATABRICKS_SERVER_HOSTNAME",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:databricks-hostname"
        },
        {
          "name": "DATABRICKS_HTTP_PATH",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:databricks-http-path"
        },
        {
          "name": "DATABRICKS_ACCESS_TOKEN",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:databricks-token"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/arcgis-databricks-feed",
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

4. **Deploy with AWS ECS**:
```bash
# Register task definition
aws ecs register-task-definition --cli-input-json file://task-definition.json

# Create service
aws ecs create-service \
  --cluster your-cluster \
  --service-name arcgis-datafeed \
  --task-definition arcgis-databricks-feed \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

### Azure Deployment (Container Instances)

```bash
# Create resource group
az group create --name arcgis-datafeed-rg --location eastus

# Create container instance
az container create \
  --resource-group arcgis-datafeed-rg \
  --name arcgis-datafeed \
  --image arcgis-databricks-feed:latest \
  --dns-name-label arcgis-datafeed \
  --ports 5000 \
  --environment-variables \
    FLASK_DEBUG=False \
  --secure-environment-variables \
    DATABRICKS_SERVER_HOSTNAME=your-workspace.cloud.databricks.com \
    DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-id \
    DATABRICKS_ACCESS_TOKEN=your-token \
  --cpu 2 \
  --memory 4
```

### GCP Deployment (Cloud Run)

```bash
# Build and push to GCR
gcloud builds submit --tag gcr.io/your-project/arcgis-databricks-feed

# Deploy to Cloud Run
gcloud run deploy arcgis-datafeed \
  --image gcr.io/your-project/arcgis-databricks-feed \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 5000 \
  --cpu 2 \
  --memory 2Gi \
  --set-env-vars FLASK_DEBUG=False \
  --set-secrets DATABRICKS_SERVER_HOSTNAME=databricks-hostname:latest,\
DATABRICKS_HTTP_PATH=databricks-http-path:latest,\
DATABRICKS_ACCESS_TOKEN=databricks-token:latest
```

### Kubernetes Deployment

Create `k8s-deployment.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: databricks-secrets
type: Opaque
stringData:
  hostname: your-workspace.cloud.databricks.com
  http-path: /sql/1.0/warehouses/your-id
  token: your-token
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: arcgis-datafeed
spec:
  replicas: 3
  selector:
    matchLabels:
      app: arcgis-datafeed
  template:
    metadata:
      labels:
        app: arcgis-datafeed
    spec:
      containers:
      - name: datafeed
        image: arcgis-databricks-feed:latest
        ports:
        - containerPort: 5000
        env:
        - name: DATABRICKS_SERVER_HOSTNAME
          valueFrom:
            secretKeyRef:
              name: databricks-secrets
              key: hostname
        - name: DATABRICKS_HTTP_PATH
          valueFrom:
            secretKeyRef:
              name: databricks-secrets
              key: http-path
        - name: DATABRICKS_ACCESS_TOKEN
          valueFrom:
            secretKeyRef:
              name: databricks-secrets
              key: token
        - name: FLASK_DEBUG
          value: "False"
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: arcgis-datafeed-service
spec:
  selector:
    app: arcgis-datafeed
  ports:
  - protocol: TCP
    port: 80
    targetPort: 5000
  type: LoadBalancer
```

Deploy:
```bash
kubectl apply -f k8s-deployment.yaml
kubectl get services
```

---

## Security Configuration

### 1. Environment Variables and Secrets

**Never commit secrets to version control.**

Use environment-specific files:
- `.env.development` (local dev)
- `.env.staging` (staging)
- `.env.production` (production)

Add to `.gitignore`:
```
.env
.env.*
!.env.example
```

### 2. Add Authentication Middleware

Update `data_feed_provider.py`:

```python
from functools import wraps
from flask import request, jsonify

API_KEYS = os.getenv('API_KEYS', '').split(',')

def require_api_key(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        api_key = request.headers.get('X-API-Key')
        if not api_key or api_key not in API_KEYS:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated_function

# Apply to endpoints
@app.route('/query', methods=['GET', 'POST'])
@require_api_key
def query():
    # ... existing code
```

### 3. CORS Configuration

```python
from flask_cors import CORS

# Configure CORS
CORS(app, resources={
    r"/query": {"origins": ["https://your-arcgis-domain.com"]},
    r"/info": {"origins": "*"}
})
```

### 4. Rate Limiting

```python
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["1000 per hour", "100 per minute"]
)

@app.route('/query')
@limiter.limit("100 per minute")
def query():
    # ... existing code
```

### 5. SSL/TLS Configuration

Use certificates from Let's Encrypt:

```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal
sudo certbot renew --dry-run
```

---

## Performance Optimization

### 1. Connection Pooling

Update `databricks_connector.py`:

```python
from databricks.sql.client import Connection
from queue import Queue
import threading

class ConnectionPool:
    def __init__(self, size=10):
        self.size = size
        self.pool = Queue(maxsize=size)
        self._init_pool()

    def _init_pool(self):
        for _ in range(self.size):
            conn = self._create_connection()
            self.pool.put(conn)

    @contextmanager
    def get_connection(self):
        conn = self.pool.get()
        try:
            yield conn
        finally:
            self.pool.put(conn)
```

### 2. Caching

```python
from flask_caching import Cache

cache = Cache(app, config={
    'CACHE_TYPE': 'redis',
    'CACHE_REDIS_URL': os.getenv('REDIS_URL', 'redis://localhost:6379/0')
})

@app.route('/query')
@cache.cached(timeout=300, query_string=True)
def query():
    # ... existing code
```

### 3. Gunicorn for Production

Create `gunicorn_config.py`:

```python
import multiprocessing

bind = "0.0.0.0:5000"
workers = multiprocessing.cpu_count() * 2 + 1
worker_class = "sync"
worker_connections = 1000
keepalive = 5
timeout = 300
accesslog = "-"
errorlog = "-"
loglevel = "info"
```

Update Dockerfile CMD:

```dockerfile
CMD ["gunicorn", "--config", "gunicorn_config.py", "src.data_feed_provider:app"]
```

---

## Monitoring

### 1. Prometheus Metrics

```python
from prometheus_flask_exporter import PrometheusMetrics

metrics = PrometheusMetrics(app)
metrics.info('app_info', 'Application info', version='1.0.0')
```

### 2. Application Logging

```python
import logging
from logging.handlers import RotatingFileHandler

if not app.debug:
    file_handler = RotatingFileHandler(
        'logs/datafeed.log',
        maxBytes=10240000,
        backupCount=10
    )
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s '
        '[in %(pathname)s:%(lineno)d]'
    ))
    file_handler.setLevel(logging.INFO)
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.INFO)
```

### 3. Health Checks

Enhanced health check:

```python
@app.route('/health')
def health():
    health_status = {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "checks": {}
    }

    # Check Databricks
    try:
        db_connector.execute_query("SELECT 1")
        health_status["checks"]["databricks"] = "connected"
    except Exception as e:
        health_status["checks"]["databricks"] = f"error: {str(e)}"
        health_status["status"] = "unhealthy"

    status_code = 200 if health_status["status"] == "healthy" else 503
    return jsonify(health_status), status_code
```

### 4. Monitoring with CloudWatch (AWS)

```python
import boto3
import time

cloudwatch = boto3.client('cloudwatch')

def send_metric(metric_name, value, unit='Count'):
    cloudwatch.put_metric_data(
        Namespace='ArcGISDataFeed',
        MetricData=[
            {
                'MetricName': metric_name,
                'Value': value,
                'Unit': unit,
                'Timestamp': time.time()
            }
        ]
    )

# Track query performance
start_time = time.time()
# ... execute query ...
duration = time.time() - start_time
send_metric('QueryDuration', duration, 'Seconds')
```

---

## Checklist

Before deploying to production:

- [ ] All secrets moved to environment variables or secrets manager
- [ ] Authentication/authorization implemented
- [ ] HTTPS/SSL configured
- [ ] Rate limiting enabled
- [ ] CORS properly configured
- [ ] Error handling and logging in place
- [ ] Health checks implemented
- [ ] Monitoring and alerting configured
- [ ] Backup and disaster recovery plan
- [ ] Load testing completed
- [ ] Security audit performed
- [ ] Documentation updated
- [ ] CI/CD pipeline configured

---

## Support

For deployment issues:
- Check logs: `docker-compose logs -f`
- Test connectivity: `curl http://localhost:5000/health`
- Review documentation: [README.md](README.md)
