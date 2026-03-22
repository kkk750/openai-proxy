/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import handleRequest from "./handle-request";

const parseOptionalPositiveInt = (value: string | undefined): number | undefined => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export interface Env {
  OPENAI_API_KEY?: string;
  PROXY_TOKEN?: string;
  MAX_BODY_BYTES?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleRequest(request, {
      openaiApiKey: env.OPENAI_API_KEY,
      proxyToken: env.PROXY_TOKEN,
      maxBodyBytes: parseOptionalPositiveInt(env.MAX_BODY_BYTES),
      rateLimitWindowMs: parseOptionalPositiveInt(env.RATE_LIMIT_WINDOW_MS),
      rateLimitMaxRequests: parseOptionalPositiveInt(env.RATE_LIMIT_MAX_REQUESTS),
    });
  },
};
