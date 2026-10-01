import { Daytona } from "@daytona/convex";
import { components } from "./_generated/api";
import { env } from "./_generated/server";

export const daytona = new Daytona(components.daytona, {
  apiKey: env.DAYTONA_API_KEY,
});
