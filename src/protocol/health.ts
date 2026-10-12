import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  phase: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const StorageHealthResponseSchema = z.object({
  status: z.literal("ok"),
  storage: z.literal("sqlite"),
});
export type StorageHealthResponse = z.infer<typeof StorageHealthResponseSchema>;

/** Every non-success API response uses this bounded JSON shape, never HTML. */
export const ApiErrorSchema = z.object({
  error: z.string().max(64),
  message: z.string().max(300),
  canonical_origin: z.string().url().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
