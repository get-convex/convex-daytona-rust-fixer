import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import { daytona } from "./daytona";
import {
  BUILD_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_LIVE_SANDBOXES,
  MAX_PROMPT_CHARS,
  rateLimiter,
} from "./limits";
import { attemptStatus } from "./schema";

const SESSION_ID = /^[0-9a-f-]{36}$/;
const BUSY = "The demo is busy right now. Try again in a few minutes, or run your own copy (link below).";

/** Ask for a Rust program. Kicks off the whole agent loop via the scheduler. */
export const start = mutation({
  args: { sessionId: v.string(), prompt: v.string(), strict: v.boolean() },
  handler: async (ctx, { sessionId, prompt, strict }) => {
    if (!SESSION_ID.test(sessionId)) throw new ConvexError("Bad session id.");
    prompt = prompt.trim();
    if (!prompt) throw new ConvexError("Describe the program you want.");
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new ConvexError(`Keep it under ${MAX_PROMPT_CHARS} characters.`);
    }

    // Throwing below rolls back this whole mutation, rate limit usage included.
    const mine = await rateLimiter.limit(ctx, "runsPerSession", { key: sessionId });
    if (!mine.ok) {
      const minutes = Math.ceil(mine.retryAfter / 60_000);
      throw new ConvexError(`You've hit the demo limit. Try again in ${minutes} min, or run your own copy (link below).`);
    }
    const everyone = await rateLimiter.limit(ctx, "runsGlobal");
    if (!everyone.ok) throw new ConvexError(BUSY);
    if ((await liveSandboxes(ctx)) >= MAX_LIVE_SANDBOXES) throw new ConvexError(BUSY);

    const runId = await ctx.db.insert("runs", {
      sessionId,
      prompt,
      strict,
      status: "starting",
      finished: false,
    });
    await ctx.scheduler.runAfter(0, internal.agent.begin, { runId });
    return runId;
  },
});

/**
 * Sandboxes that are (or are about to be) running: unfinished runs in our own
 * table (transactional, so two clicks can't both squeeze in), or live rows in
 * the component's table (catches any sandbox a crashed run left behind).
 */
async function liveSandboxes(ctx: QueryCtx) {
  const recent = Date.now() - BUILD_TIMEOUT_MS * MAX_ATTEMPTS;
  const active = await ctx.db
    .query("runs")
    .withIndex("by_finished", (q) => q.eq("finished", false).gt("_creationTime", recent))
    .take(MAX_LIVE_SANDBOXES);
  const sandboxes = await daytona.listSandboxes(ctx, { limit: 100 });
  const live = sandboxes.filter((s) => ["started", "starting", "creating", "pending_build", "building_snapshot"].includes(s.state));
  return Math.max(active.length, live.length);
}

export const list = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    return await ctx.db
      .query("runs")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .take(20);
  },
});

/** Everything the run page needs, live: the run, its attempts, the sandbox, and the build log. */
export const get = query({
  args: { sessionId: v.string(), runId: v.id("runs") },
  handler: async (ctx, { sessionId, runId }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run || run.sessionId !== sessionId) return null;
    const attempts = await ctx.db
      .query("attempts")
      .withIndex("by_run", (q) => q.eq("runId", runId))
      .take(MAX_ATTEMPTS);
    const sandbox = run.sandboxId
      ? await daytona.getSandbox(ctx, { sandboxId: run.sandboxId })
      : null;
    // While cargo runs, its output lands in the component's execution row.
    // Reading it here makes the log stream to the browser with no polling code.
    const building = attempts.find((a) => a.status === "building");
    const execution = building?.executionId
      ? await daytona.getExecution(ctx, { executionId: building.executionId })
      : null;
    return {
      run,
      attempts,
      sandboxState: sandbox?.state ?? null,
      liveLog: execution?.result ?? "",
    };
  },
});

// ---- Internal: called by the agent in agent.ts ----

export const getRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get("runs", runId);
    const attempts = run
      ? await ctx.db
          .query("attempts")
          .withIndex("by_run", (q) => q.eq("runId", runId))
          .take(MAX_ATTEMPTS)
      : [];
    return run && { run, attempts };
  },
});

export const updateRun = internalMutation({
  args: {
    runId: v.id("runs"),
    sandboxId: v.optional(v.string()),
    sandboxCreateMs: v.optional(v.number()),
    output: v.optional(v.string()),
    exitCode: v.optional(v.number()),
  },
  handler: async (ctx, { runId, ...fields }) => {
    if (await ctx.db.get("runs", runId)) await ctx.db.patch("runs", runId, fields);
  },
});

export const finishRun = internalMutation({
  args: { runId: v.id("runs"), error: v.optional(v.string()) },
  handler: async (ctx, { runId, error }) => {
    const run = await ctx.db.get("runs", runId);
    if (!run || run.finished) return;
    await ctx.db.patch("runs", runId, {
      status: error ? "failed" : "succeeded",
      finished: true,
      error,
    });
  },
});

export const createAttempt = internalMutation({
  args: { runId: v.id("runs"), number: v.number() },
  handler: async (ctx, { runId, number }) => {
    if (number > 1) await ctx.db.patch("runs", runId, { status: "fixing" });
    return await ctx.db.insert("attempts", { runId, number, code: "", status: "writing" });
  },
});

export const updateAttempt = internalMutation({
  args: {
    attemptId: v.id("attempts"),
    code: v.optional(v.string()),
    status: v.optional(attemptStatus),
  },
  handler: async (ctx, { attemptId, ...fields }) => {
    if (await ctx.db.get("attempts", attemptId)) await ctx.db.patch("attempts", attemptId, fields);
  },
});

/** cargo build is running in the background: start watching it. */
export const buildStarted = internalMutation({
  args: { attemptId: v.id("attempts"), executionId: v.string() },
  handler: async (ctx, { attemptId, executionId }) => {
    const attempt = await ctx.db.get("attempts", attemptId);
    if (!attempt) return;
    await ctx.db.patch("attempts", attemptId, {
      status: "building",
      executionId,
      buildStartedAt: Date.now(),
    });
    await ctx.db.patch("runs", attempt.runId, { status: "building" });
    await ctx.scheduler.runAfter(250, internal.runs.checkBuild, { attemptId, delayMs: 250 });
  },
});

/**
 * runBackground has no completion callback, so this re-checks the component's
 * execution row (a cheap database read, no Daytona call) with backoff until
 * cargo exits. Then it decides what's next: run it, fix it, or give up.
 */
export const checkBuild = internalMutation({
  args: { attemptId: v.id("attempts"), delayMs: v.number() },
  handler: async (ctx, { attemptId, delayMs }) => {
    const attempt = await ctx.db.get("attempts", attemptId);
    if (!attempt?.executionId || attempt.status !== "building") return;
    const execution = await daytona.getExecution(ctx, { executionId: attempt.executionId });

    const timedOut = Date.now() - attempt.buildStartedAt! > BUILD_TIMEOUT_MS;
    if (execution?.status === "running" && !timedOut) {
      const next = Math.min(delayMs * 2, 2_000);
      await ctx.scheduler.runAfter(next, internal.runs.checkBuild, { attemptId, delayMs: next });
      return;
    }

    const passed = execution?.status === "completed" && execution.exitCode === 0;
    const finishedAt = execution?.finishedAt ?? Date.now();
    await ctx.db.patch("attempts", attemptId, {
      status: passed ? "passed" : "failed",
      log: execution?.result || execution?.error || "cargo build timed out.",
      buildMs: finishedAt - attempt.buildStartedAt!,
    });
    console.log(`attempt ${attempt.number} ${passed ? "passed" : "failed"}: build took ${finishedAt - attempt.buildStartedAt!}ms, noticed ${Date.now() - finishedAt}ms later`);

    const runId = attempt.runId;
    if (passed) {
      await ctx.db.patch("runs", runId, { status: "running" });
      await ctx.scheduler.runAfter(0, internal.agent.runProgram, { runId });
    } else if (attempt.number < MAX_ATTEMPTS && !timedOut) {
      await ctx.scheduler.runAfter(0, internal.agent.fix, { runId, number: attempt.number + 1 });
    } else {
      const error = timedOut
        ? "cargo build timed out."
        : `Still not compiling after ${MAX_ATTEMPTS} attempts.`;
      await ctx.scheduler.runAfter(0, internal.agent.cleanup, { runId, error });
    }
  },
});
