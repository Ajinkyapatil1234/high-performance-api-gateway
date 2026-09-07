# High-Performance API Gateway

A production-inspired API Gateway demo built with **Node.js, TypeScript, Fastify, Docker, Kubernetes, Prometheus, Grafana, and HPA autoscaling**.

The project demonstrates how an API gateway can handle sustained traffic while providing resilience, observability, rate limiting, and automatic horizontal scaling.

> **Note:** This is a local/demo project designed to demonstrate real-world gateway architecture and behavior. It is not intended to be a production deployment.

---

## Architecture

```text
                         Client
                           |
                           v
                 +-------------------+
                 |    API Gateway    |
                 |   Fastify :3000   |
                 |                   |
                 | - Rate Limiting   |
                 | - Timeout         |
                 | - Circuit Breaker |
                 | - Prometheus      |
                 |   Metrics         |
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 | Backend Service   |
                 |   Node.js :4000   |
                 +-------------------+

                     Kubernetes
                           |
                           v
                 +-------------------+
                 |       HPA         |
                 |    2 -> 5 Pods    |
                 +-------------------+
                           |
                           v
              +-------------------------+
              | Prometheus + Grafana    |
              | Monitoring & Metrics    |
              +-------------------------+
