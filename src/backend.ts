import Fastify from "fastify";

const app = Fastify({
  logger: true,
});

app.get("/hello", async () => {
  return {
    message: "Hello from backend service",
    service: "backend",
  };
});

const start = async () => {
  try {
    await app.listen({
      port: 4000,
      host: "0.0.0.0",
    });

    console.log("Backend running on http://localhost:4000");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();
