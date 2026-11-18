import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./index";
import { QualificationCommandSchema } from "./qualification/contracts";
import { qualificationRequestAuthorization } from "./qualification/NativeBoundaryQualificationAuth";
export { AgentRuntime } from "./core/AgentRuntime";
export { Sandbox } from "./core/OwnedNativeSandbox";
export { ContainerProxy } from "@cloudflare/sandbox";

/** Only the named, provider-authenticated private binding has injected props.
 * A public/default HTTP invocation, including one with the secret, is denied. */
export class NativeBoundaryQualificationControl extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const auth = qualificationRequestAuthorization(this.env, request, this.ctx.props);
      const match = new URL(request.url).pathname.match(/^\/internal\/native-boundary-qualification\/v1\/(reserve|provision|status|retire|qualify|stop)$/);
      if (request.method !== "POST" || !match) return new Response("Not Found", { status: 404 });
      const text = await request.text();
      if (text.length > 4096) return new Response("Invalid request", { status: 400 });
      const command = QualificationCommandSchema.parse({ ...JSON.parse(text), action: match[1] });
      // Every operation in this new environment uses the same existing physical
      // authority serializer. The caller cannot choose a DO, lease or Sandbox.
      const id = this.env.AGENT_RUNTIME.idFromName(`native-boundary-qualification:${auth.props.environmentId}`);
      const result = await this.env.AGENT_RUNTIME.get(id).qualificationControl(auth, command);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      // Never log raw helper replies, operator credentials or request bodies.
      return Response.json({ error: "Native qualification authority or original operation unavailable" },
        { status: 409, headers: { "Cache-Control": "no-store" } });
    }
  }
}
export default { fetch: async () => new Response("Not Found", { status: 404 }) };
