/**
 * Puts the demo back to a clean slate: deletes every sandbox this app created,
 * then wipes our tables. Safe to run at any time, and as often as you like.
 *
 *   npx convex run reset:resetDemo
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { daytona } from "./daytona";
import { APP_NAME } from "./limits";

export const resetDemo = internalAction({
  args: {},
  handler: async (ctx) => {
    const sandboxes = await daytona.listSandboxes(ctx, { limit: 500 });
    let deleted = 0;
    for (const { sandboxId, state, labels } of sandboxes) {
      if (state === "destroyed" || labels?.app !== APP_NAME) continue;
      try {
        await daytona.deleteSandbox(ctx, { sandboxId });
        deleted++;
      } catch {
        // Already gone (auto-deleted)? This marks it destroyed in the component.
        await daytona.refreshSandbox(ctx, { sandboxId }).catch(() => {});
      }
    }
    let wiped = 0;
    for (const table of ["attempts", "runs"] as const) {
      let batch;
      do {
        batch = await ctx.runMutation(internal.reset.wipe, { table });
        wiped += batch;
      } while (batch > 0);
    }
    console.log(`reset: deleted ${deleted} sandboxes, wiped ${wiped} rows`);
    return { deleted, wiped };
  },
});

export const wipe = internalMutation({
  args: { table: v.union(v.literal("runs"), v.literal("attempts")) },
  handler: async (ctx, { table }) => {
    const rows = await ctx.db.query(table).take(500);
    for (const row of rows) await ctx.db.delete(table, row._id);
    return rows.length;
  },
});
