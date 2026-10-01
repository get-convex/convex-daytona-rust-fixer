import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Public demo hygiene: wipe everything twice a day.
crons.interval("reset demo", { hours: 12 }, internal.reset.resetDemo);

export default crons;
