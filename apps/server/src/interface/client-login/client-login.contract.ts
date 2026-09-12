import { defineContract } from "@raven.js/core/contract";
import { z } from "zod";

export const ClientLoginContract = defineContract({
  method: "POST", path: "/api/client/login",
  schemas: { body: z.object({ protocolVersion: z.literal(1), username: z.string().min(1).max(320), password: z.string().min(1).max(4096) }).strict() },
});
