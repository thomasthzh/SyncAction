import type { FastifyInstance } from "fastify";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ADMIN_API_PREFIX = "/v1/admin/";
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'";

export interface AdminSecurityOptions {
  publicOrigin: string;
}

function errorPayload(code: string, requestId: string) {
  return {
    code,
    message: code,
    requestId,
  };
}

export function registerAdminSecurity(app: FastifyInstance, options: AdminSecurityOptions): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith(ADMIN_API_PREFIX) || SAFE_METHODS.has(request.method)) {
      return;
    }
    if (request.headers.origin !== options.publicOrigin) {
      return reply.status(403).send(errorPayload("ADMIN_ORIGIN_REQUIRED", request.id));
    }
    const mediaType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return reply.status(415).send(errorPayload("ADMIN_JSON_REQUIRED", request.id));
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.headers({
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    if (options.publicOrigin.startsWith("https://")) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    if (request.url.startsWith(ADMIN_API_PREFIX)) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });
}
