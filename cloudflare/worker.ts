import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  PLANNER: DurableObjectNamespace<Planner>;
  ASSETS: Fetcher;
  SNAPSHOTS: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  NIGHTSHIFT_INTERNAL_SECRET?: string;
  NIGHTSHIFT_SNAPSHOT_URL?: string;
}

export class Planner extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "15m";
  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      GEMINI_API_KEY: env.GEMINI_API_KEY || "",
      GEMINI_MODEL: env.GEMINI_MODEL || "gemini-3.8-flash",
      NIGHTSHIFT_SNAPSHOT_URL: env.NIGHTSHIFT_SNAPSHOT_URL || "",
      NIGHTSHIFT_INTERNAL_SECRET: env.NIGHTSHIFT_INTERNAL_SECRET || "",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/internal/snapshots/")) {
      if (
        !env.NIGHTSHIFT_INTERNAL_SECRET ||
        request.headers.get("Authorization") !==
          `Bearer ${env.NIGHTSHIFT_INTERNAL_SECRET}`
      )
        return new Response("Unauthorized", { status: 401 });
      const key = url.pathname.slice("/internal/snapshots/".length);
      if (!/^(instances|runs)\/[a-zA-Z0-9_-]+$/.test(key))
        return new Response("Invalid key", { status: 400 });
      if (request.method === "PUT") {
        const text = await request.text();
        if (text.length > 10_000_000)
          return new Response("Snapshot too large", { status: 413 });
        await env.SNAPSHOTS.put(`${key}.json`, text, {
          httpMetadata: { contentType: "application/json" },
        });
        return new Response("Saved");
      }
      if (request.method === "GET") {
        const object = await env.SNAPSHOTS.get(`${key}.json`);
        return object
          ? new Response(object.body, {
              headers: { "Content-Type": "application/json" },
            })
          : new Response("Not found", { status: 404 });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname.startsWith("/api/")) {
      const planner = getContainer(env.PLANNER, "nightshift");
      return planner.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
