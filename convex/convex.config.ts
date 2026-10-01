import daytona from "@daytona/convex/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  // The static site owns "/", so any HTTP routes of our own would live under /api.
  httpPrefix: "/api",
  env: {
    DAYTONA_API_KEY: v.string(),
    // Optional: name of a pre-built Daytona snapshot with Rust installed (see README).
    RUST_SNAPSHOT: v.optional(v.string()),
  },
});
app.use(daytona);
app.use(rateLimiter);
app.use(staticHosting, { httpPrefix: "/" });

export default app;
