/**
 * HTTP API Schemas
 * Zod validation for all HTTP endpoints
 *
 * SOLID: Single responsibility (request/response validation)
 * Type Safety: All inputs validated at runtime
 */

import { z } from "zod";

/**
 * Session Management Schemas
 */

const WorkspaceScopeSchema = z
  .object({
    runId: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    runAttemptId: z.string().min(1),
    workspaceId: z.string().min(1),
    root: z.string().min(1),
  })
  .strict();

export const SessionCreateRequestSchema = z
  .object({
    runId: z.string().min(1, "runId required"),
    taskId: z.string().min(1, "taskId required"),
    repoPath: z
      .string()
      .min(1, "repoPath required")
      .refine(
        (path) => !path.startsWith("/"),
        "repoPath must be relative, not absolute",
      )
      .refine(
        (path) => !path.includes(".."),
        "repoPath must not contain path traversal",
      ),
    workspaceScope: WorkspaceScopeSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    if (value.workspaceScope && value.workspaceScope.runId !== value.runId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspaceScope", "runId"],
        message: "workspaceScope.runId must match runId",
      });
    }
  });

export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;

export const SessionCreateResponseSchema = z.object({
  sessionId: z.string().min(1),
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
  manifest: z.unknown().optional(),
  lease: z.object({
    leaseId: z.string().min(1),
    sandboxId: z.string().min(1),
    workspaceScope: WorkspaceScopeSchema,
    owner: z.string().min(1),
    correlationId: z.string().min(1),
    expiresAt: z.number().int().positive(),
    generation: z.number().int().nonnegative(),
    mutationMode: z.enum(["serialized", "read_only"]),
  }),
});

export type SessionCreateResponse = z.infer<typeof SessionCreateResponseSchema>;

export const SessionResumeRequestSchema = z
  .object({
    workspaceScope: WorkspaceScopeSchema,
    lease: z
      .object({
        leaseId: z.string().min(1),
        sandboxId: z.string().min(1),
        generation: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type SessionResumeRequest = z.infer<typeof SessionResumeRequestSchema>;

/**
 * Task Execution Schemas
 */

export const ExecuteTaskRequestSchema = z.object({
  sessionId: z.string().min(1, "sessionId required"),
  taskId: z.string().min(1, "taskId required"),
  action: z.string().min(1, "action required"),
  params: z.record(z.unknown()),
  timeout: z.number().int().positive().optional(),
  retryable: z.boolean().optional(),
});

export type ExecuteTaskRequest = z.infer<typeof ExecuteTaskRequestSchema>;

export const CancelTaskRequestSchema = z
  .object({
    sessionId: z.string().min(1, "sessionId required"),
    taskId: z.string().min(1, "taskId required"),
  })
  .strict();

export type CancelTaskRequest = z.infer<typeof CancelTaskRequestSchema>;

export const ExecuteTaskResponseSchema = z.object({
  taskId: z.string().min(1),
  leaseId: z.string().min(1),
  correlationId: z.string().min(1),
  status: z.enum(["success", "failure", "timeout", "cancelled", "sandbox_unavailable"]),
  retryable: z.boolean(),
  output: z.string().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
    })
    .optional(),
  metrics: z
    .object({
      duration: z.number().int().nonnegative(),
      memoryUsed: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type ExecuteTaskResponse = z.infer<typeof ExecuteTaskResponseSchema>;


/**
 * Session Cleanup Schemas
 */

export const DeleteSessionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>;

/**
 * Error Response Schema
 */

export const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
  timestamp: z.number().int().positive(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Helper: Validate request body with Zod
 */
export async function validateRequestBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ valid: true; data: T } | { valid: false; error: string }> {
  try {
    const body = await request.json();
    const result = schema.safeParse(body);

    if (!result.success) {
      const messages = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      return { valid: false, error: messages };
    }

    return { valid: true, data: result.data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Invalid JSON";
    return { valid: false, error: `Request parsing failed: ${msg}` };
  }
}

/**
 * Helper: Validate query parameters with Zod
 */
export function validateQueryParams<T>(
  url: URL,
  schema: z.ZodType<T>,
): { valid: true; data: T } | { valid: false; error: string } {
  try {
    const params: Record<string, string | null> = {};

    for (const [key, value] of url.searchParams.entries()) {
      params[key] = value;
    }

    const result = schema.safeParse(params);

    if (!result.success) {
      const messages = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      return { valid: false, error: messages };
    }

    return { valid: true, data: result.data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Query parsing failed";
    return { valid: false, error: msg };
  }
}

/**
 * Helper: Create JSON response
 */
export function jsonResponse<T>(
  data: T,
  status: number = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

/**
 * Helper: Create error response
 */
export function errorResponse(
  error: string,
  code: string,
  status: number = 400,
  details?: unknown,
): Response {
  const response: ErrorResponse = {
    error,
    code,
    details,
    timestamp: Date.now(),
  };
  return jsonResponse(response, status);
}

/**
 * Helper: Extract path parameter
 */
export function getPathParam(url: URL, paramIndex: number): string | null {
  const parts = url.pathname.split("/");
  return parts[paramIndex] || null;
}

/**
 * Chat History Schemas
 */
export const ChatHistoryQuerySchema = z.object({
  runId: z.string().min(1, "runId required"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ChatHistoryQuery = z.infer<typeof ChatHistoryQuerySchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1, "content required"),
  idempotencyKey: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatAppendRequestSchema = z
  .object({
    message: ChatMessageSchema.optional(),
    messages: z.array(ChatMessageSchema).optional(),
    idempotencyKey: z.string().optional(),
  })
  .refine(
    (data) => data.message || (data.messages && data.messages.length > 0),
    "Either message or messages array must be provided",
  );

export type ChatAppendRequest = z.infer<typeof ChatAppendRequestSchema>;
