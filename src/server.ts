import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import dotenv from "dotenv";
import http from "node:http";
import https from "node:https";
import client from "prom-client";

dotenv.config();

const app = Fastify({
  logger: false,
});

const PORT = Number(process.env.PORT) || 3000;

const BACKEND_URL =
  process.env.BACKEND_URL || "http://localhost:4000";

const BACKEND_TIMEOUT_MS =
  Number(process.env.BACKEND_TIMEOUT_MS) || 5000;

const backend = new URL(BACKEND_URL);

/*
 * ============================================================
 * PROMETHEUS METRICS
 * ============================================================
 */

client.collectDefaultMetrics({
  prefix: "api_gateway_",
});

const httpRequestsTotal = new client.Counter({
  name: "api_gateway_http_requests_total",
  help: "Total number of HTTP requests handled by the API gateway",
  labelNames: ["method", "route", "status_code"],
});

const httpRequestDuration = new client.Histogram({
  name: "api_gateway_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2,
    5,
  ],
});

/*
 * Record metrics for every completed HTTP request.
 */
app.addHook("onRequest", async (request) => {
  (request as typeof request & {
    metricsStartTime?: bigint;
  }).metricsStartTime = process.hrtime.bigint();
});

app.addHook("onResponse", async (request, reply) => {
  const requestWithMetrics = request as typeof request & {
    metricsStartTime?: bigint;
  };

  const startTime = requestWithMetrics.metricsStartTime;

  if (!startTime) {
    return;
  }

  const durationSeconds =
    Number(process.hrtime.bigint() - startTime) / 1_000_000_000;

  const route =
    request.routeOptions?.url || request.url;

  const method = request.method;
  const statusCode = String(reply.statusCode);

  httpRequestsTotal.inc({
    method,
    route,
    status_code: statusCode,
  });

  httpRequestDuration.observe(
    {
      method,
      route,
      status_code: statusCode,
    },
    durationSeconds
  );
});

/*
 * Prometheus metrics endpoint.
 */
app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", client.register.contentType);

  return reply.send(await client.register.metrics());
});

/*
 * ============================================================
 * HTTP CONNECTION POOLS
 * ============================================================
 *
 * Keep connections alive so the gateway does not create
 * a new TCP connection for every backend request.
 */

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1024,
  maxFreeSockets: 256,
  keepAliveMsecs: 1000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1024,
  maxFreeSockets: 256,
  keepAliveMsecs: 1000,
});

/*
 * ============================================================
 * BACKEND HTTP ERRORS
 * ============================================================
 */

class BackendHttpError extends Error {
  constructor(public statusCode: number) {
    super(`Backend returned HTTP ${statusCode}`);
    this.name = "BackendHttpError";
  }
}

/*
 * ============================================================
 * CIRCUIT BREAKER
 * ============================================================
 *
 * CLOSED:
 *   Requests normally go to the backend.
 *
 * OPEN:
 *   Backend is considered unhealthy.
 *   Requests fail immediately without contacting backend.
 *
 * HALF_OPEN:
 *   After the reset timeout, allow one request to test recovery.
 */

class CircuitBreaker {
  private state:
    | "CLOSED"
    | "OPEN"
    | "HALF_OPEN" = "CLOSED";

  private failures = 0;

  private lastFailureTime = 0;

  private readonly failureThreshold = 5;

  private readonly resetTimeoutMs = 10_000;

  private halfOpenRequestInProgress = false;

  getState() {
    if (
      this.state === "OPEN" &&
      Date.now() - this.lastFailureTime >=
        this.resetTimeoutMs
    ) {
      this.state = "HALF_OPEN";
      this.halfOpenRequestInProgress = false;

      console.log(
        "Circuit breaker: OPEN -> HALF_OPEN"
      );
    }

    return this.state;
  }

  canRequest(): boolean {
    const state = this.getState();

    if (state === "CLOSED") {
      return true;
    }

    if (state === "OPEN") {
      return false;
    }

    if (state === "HALF_OPEN") {
      if (this.halfOpenRequestInProgress) {
        return false;
      }

      this.halfOpenRequestInProgress = true;

      return true;
    }

    return false;
  }

  recordSuccess() {
    if (this.state === "HALF_OPEN") {
      console.log(
        "Circuit breaker: HALF_OPEN -> CLOSED"
      );
    }

    this.state = "CLOSED";
    this.failures = 0;
    this.halfOpenRequestInProgress = false;
  }

  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();

    this.halfOpenRequestInProgress = false;

    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";

      console.log(
        "Circuit breaker: HALF_OPEN -> OPEN"
      );

      return;
    }

    if (
      this.state === "CLOSED" &&
      this.failures >= this.failureThreshold
    ) {
      this.state = "OPEN";

      console.log(
        `Circuit breaker: CLOSED -> OPEN after ${this.failures} failures`
      );
    }
  }

  getStats() {
    return {
      state: this.getState(),
      failures: this.failures,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
    };
  }
}

const circuitBreaker = new CircuitBreaker();

/*
 * ============================================================
 * BACKEND REQUEST
 * ============================================================
 */

function proxyRequest(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const isHttps = backend.protocol === "https:";

    const transport = isHttps ? https : http;

    const agent = isHttps
      ? httpsAgent
      : httpAgent;

    const request = transport.request(
      {
        hostname: backend.hostname,
        port: backend.port,
        path,
        method: "GET",
        agent,
        headers: {
          accept: "application/json",
        },
      },
      (response) => {
        const statusCode =
          response.statusCode || 500;

        if (
          statusCode < 200 ||
          statusCode >= 300
        ) {
          response.resume();

          reject(
            new BackendHttpError(statusCode)
          );

          return;
        }

        let body = "";

        response.setEncoding("utf8");

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(
              new Error(
                "Invalid JSON returned by backend"
              )
            );
          }
        });
      }
    );

    const timeout = setTimeout(() => {
      request.destroy();

      const error = new Error(
        "Backend request timed out"
      );

      error.name = "TimeoutError";

      reject(error);
    }, BACKEND_TIMEOUT_MS);

    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    request.on("close", () => {
      clearTimeout(timeout);
    });

    request.end();
  });
}

/*
 * ============================================================
 * RATE LIMITING
 * ============================================================
 *
 * 1000 requests per minute per client IP.
 */

app.register(rateLimit, {
  max: 60000,
  timeWindow: "1 minute",

  errorResponseBuilder: (_request, context) => {
    return {
      statusCode: 429,
      error: "Too Many Requests",
      message:
        "Rate limit exceeded. Try again later.",
      retryAfter: context.after,
    };
  },
});

/*
 * ============================================================
 * GATEWAY HEALTH CHECK
 * ============================================================
 */

app.get("/health", async () => {
  return {
    status: "ok",
    service: "api-gateway",
  };
});

/*
 * ============================================================
 * CIRCUIT BREAKER STATUS
 * ============================================================
 */

app.get("/circuit-breaker", async () => {
  return {
    service: "api-gateway",
    circuitBreaker: circuitBreaker.getStats(),
  };
});

/*
 * ============================================================
 * MAIN GATEWAY ROUTE
 * ============================================================
 */

app.get("/api/hello", async (_request, reply) => {
  /*
   * Check circuit breaker before contacting backend.
   */
  if (!circuitBreaker.canRequest()) {
    return reply.status(503).send({
      statusCode: 503,
      error: "Service Unavailable",
      message:
        "Backend service is temporarily unavailable",
      circuitBreaker:
        circuitBreaker.getState(),
    });
  }

  try {
    const data = await proxyRequest("/hello");

    /*
     * Backend succeeded.
     */
    circuitBreaker.recordSuccess();

    return reply.send(data);
  } catch (error) {
    /*
     * Backend failed.
     */
    circuitBreaker.recordFailure();

    if (
      error instanceof Error &&
      error.name === "TimeoutError"
    ) {
      return reply.status(504).send({
        statusCode: 504,
        error: "Gateway Timeout",
        message: "Backend request timed out",
      });
    }

    if (error instanceof BackendHttpError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: "Backend Error",
        message:
          `Backend returned HTTP ${error.statusCode}`,
      });
    }

    app.log.error(error);

    return reply.status(502).send({
      statusCode: 502,
      error: "Bad Gateway",
      message:
        "Unable to connect to backend service",
    });
  }
});

/*
 * ============================================================
 * START GATEWAY
 * ============================================================
 */

const start = async () => {
  try {
    await app.listen({
      port: PORT,
      host: "0.0.0.0",
    });

    console.log(
      `API Gateway running on http://localhost:${PORT}`
    );

    console.log(
      `Backend configured at ${BACKEND_URL}`
    );

    console.log(
      `Backend timeout: ${BACKEND_TIMEOUT_MS}ms`
    );

    console.log(
      "Backend connections: keep-alive enabled"
    );

    console.log(
      "Backend max sockets: 1024"
    );

    console.log(
      "Rate limit: 1000 requests per minute per IP"
    );

    console.log(
      "Circuit breaker: 5 failures / 10 second reset"
    );

    console.log(
      "Prometheus metrics: /metrics"
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();