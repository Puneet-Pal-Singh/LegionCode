import { z } from "zod";

const waitlistRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  company: z.string().max(200).optional().default(""),
  source: z.string().trim().max(80).optional().default("cloud-page"),
});

export interface WaitlistEntry {
  id: string;
  email: string;
  source: string;
  createdAt: string;
}

interface WaitlistRequestDependencies {
  save: (entry: WaitlistEntry) => Promise<void>;
}

export async function handleWaitlistRequest(
  request: Request,
  dependencies: WaitlistRequestDependencies,
): Promise<Response> {
  const parsed = await parseWaitlistRequest(request);
  if (!parsed.success) return parsed.response;

  if (parsed.data.company) {
    return acceptedResponse();
  }

  await dependencies.save({
    id: crypto.randomUUID(),
    email: parsed.data.email,
    source: parsed.data.source,
    createdAt: new Date().toISOString(),
  });
  return acceptedResponse();
}

async function parseWaitlistRequest(request: Request) {
  try {
    const body: unknown = await request.json();
    const result = waitlistRequestSchema.safeParse(body);
    if (result.success) return result;
    return {
      success: false as const,
      response: Response.json(
        { error: "Enter a valid email address." },
        { status: 400 },
      ),
    };
  } catch {
    return {
      success: false as const,
      response: Response.json(
        { error: "Submit a valid JSON request." },
        { status: 400 },
      ),
    };
  }
}

function acceptedResponse(): Response {
  return Response.json(
    { message: "Your private-alpha request has been recorded." },
    { status: 202 },
  );
}
