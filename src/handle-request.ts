type RequestLike = Request & { nextUrl?: URL };

export type HandleRequestOptions = {
  openaiApiKey?: string;
  proxyToken?: string;
  maxBodyBytes?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
};

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type GlobalState = {
  __openaiProxyRateLimitStore?: Map<string, RateLimitEntry>;
  process?: {
    env?: Record<string, string | undefined>;
  };
};

const OPENAI_API_BASE_URL = "https://api.openai.com";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;

const ALLOWED_METHODS = new Set(["GET", "POST", "OPTIONS"]);
const ALLOWED_PATHS = new Set([
  "/v1/models",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/embeddings",
  "/v1/moderations",
  "/v1/images/generations",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
  "/v1/audio/translations",
]);

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

const pickHeaders = (headers: Headers, keys: (string | RegExp)[]): Headers => {
  const picked = new Headers();
  for (const key of headers.keys()) {
    if (keys.some((k) => (typeof k === "string" ? k === key : k.test(key)))) {
      const value = headers.get(key);
      if (typeof value === "string") {
        picked.set(key, value);
      }
    }
  }
  return picked;
};

const jsonError = (
  status: number,
  message: string,
  extraHeaders?: Record<string, string>
) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json",
      ...extraHeaders,
    },
  });

const getEnv = (key: string): string | undefined =>
  (globalThis as GlobalState).process?.env?.[key];

const parsePositiveInt = (
  value: string | number | undefined,
  fallback: number
): number => {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const extractProxyToken = (req: RequestLike): string => {
  const header = req.headers.get("authorization");
  if (!header) {
    return "";
  }

  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return "";
  }

  return token.trim();
};

const getClientIp = (req: RequestLike): string => {
  const sources = [
    req.headers.get("cf-connecting-ip"),
    req.headers.get("x-real-ip"),
    req.headers.get("x-forwarded-for"),
  ];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const ip = source.split(",")[0]?.trim();
    if (ip) {
      return ip;
    }
  }
  return "unknown";
};

const isAllowedPath = (pathname: string): boolean =>
  ALLOWED_PATHS.has(pathname) || pathname.startsWith("/v1/files");

const checkRateLimit = (
  ip: string,
  windowMs: number,
  maxRequests: number
): { allowed: true } | { allowed: false; retryAfter: number } => {
  const state = globalThis as GlobalState;
  const store = (state.__openaiProxyRateLimitStore ??= new Map());
  const now = Date.now();
  const current = store.get(ip);

  if (!current || current.resetAt <= now) {
    store.set(ip, {
      count: 1,
      resetAt: now + windowMs,
    });
    return { allowed: true };
  }

  if (current.count >= maxRequests) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  current.count += 1;
  store.set(ip, current);
  return { allowed: true };
};

export default async function handleRequest(
  req: RequestLike,
  options: HandleRequestOptions = {}
) {
  const openaiApiKey = options.openaiApiKey ?? getEnv("OPENAI_API_KEY") ?? "";
  const proxyToken = options.proxyToken ?? getEnv("PROXY_TOKEN") ?? "";
  const maxBodyBytes = parsePositiveInt(
    options.maxBodyBytes ?? getEnv("MAX_BODY_BYTES"),
    DEFAULT_MAX_BODY_BYTES
  );
  const rateLimitWindowMs = parsePositiveInt(
    options.rateLimitWindowMs ?? getEnv("RATE_LIMIT_WINDOW_MS"),
    DEFAULT_RATE_LIMIT_WINDOW_MS
  );
  const rateLimitMaxRequests = parsePositiveInt(
    options.rateLimitMaxRequests ?? getEnv("RATE_LIMIT_MAX_REQUESTS"),
    DEFAULT_RATE_LIMIT_MAX_REQUESTS
  );

  if (!openaiApiKey || !proxyToken) {
    return jsonError(500, "Server missing OPENAI_API_KEY or PROXY_TOKEN");
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  if (!ALLOWED_METHODS.has(req.method)) {
    return jsonError(405, `Method ${req.method} is not allowed`);
  }

  if (extractProxyToken(req) !== proxyToken) {
    return jsonError(401, "Unauthorized");
  }

  const contentLength = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return jsonError(413, `Request body exceeds ${maxBodyBytes} bytes`);
  }

  const ip = getClientIp(req);
  const rateLimit = checkRateLimit(ip, rateLimitWindowMs, rateLimitMaxRequests);
  if (!rateLimit.allowed) {
    return jsonError(429, "Too many requests", {
      "retry-after": String(rateLimit.retryAfter),
    });
  }

  const { pathname, search } = req.nextUrl ? req.nextUrl : new URL(req.url);
  if (!isAllowedPath(pathname)) {
    return jsonError(403, `Path ${pathname} is not allowed`);
  }

  const url = new URL(pathname + search, OPENAI_API_BASE_URL).href;
  const headers = pickHeaders(req.headers, ["content-type", /^openai-/]);
  headers.set("authorization", `Bearer ${openaiApiKey}`);

  const res = await fetch(url, {
    body: req.body,
    method: req.method,
    headers,
  });

  const resHeaders = {
    ...CORS_HEADERS,
    ...Object.fromEntries(
      pickHeaders(res.headers, ["content-type", /^x-ratelimit-/, /^openai-/])
    ),
  };

  return new Response(res.body, {
    headers: resHeaders,
    status: res.status,
  });
}
