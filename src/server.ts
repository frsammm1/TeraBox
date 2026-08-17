import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { ShareResolver } from "./lib/share-service.js";
import { type ResolvedShare, TeraBoxError } from "./lib/terabox.js";
import { extractSurl, formatBytes, isValidShareUrl } from "./lib/utils.js";

export interface TelegramStatusProvider {
  getStatus(): unknown;
}

export interface TransferStatusProvider {
  getStatus(): unknown;
  getDashboard?(): unknown;
}

export interface ApiServerOptions {
  config: AppConfig;
  resolver: ShareResolver;
  telegramBot?: TelegramStatusProvider;
  transferManager?: TransferStatusProvider;
  logger?: Pick<Console, "error">;
}

function corsHeaders(config: AppConfig): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function writeJson(
  response: ServerResponse,
  config: AppConfig,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(config),
  });
  response.end(JSON.stringify(body));
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAdminAuthorized(request: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return false;
  }
  const authorization = request.headers.authorization;
  if (!authorization) {
    return false;
  }
  if (authorization.startsWith("Bearer ")) {
    return secureEquals(authorization.slice(7), apiKey);
  }
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator > 0 && decoded.slice(0, separator) === "admin" && secureEquals(decoded.slice(separator + 1), apiKey);
    } catch {
      return false;
    }
  }
  return false;
}

function methodNotAllowed(response: ServerResponse, config: AppConfig): void {
  response.setHeader("Allow", "GET, OPTIONS");
  writeJson(response, config, 405, { status: "error", message: "Method not allowed" });
}

function toPublicFile(file: ResolvedShare["files"][number]): Record<string, unknown> {
  return {
    name: file.name,
    ...(file.sizeBytes !== undefined && {
      size_bytes: file.sizeBytes,
      size: formatBytes(file.sizeBytes),
    }),
    is_folder: file.isFolder,
    ...(file.download && { download: file.download }),
    ...(file.thumbs && { thumbs: file.thumbs }),
  };
}

function successResponse(
  share: ResolvedShare,
  sourceUrl: string,
  elapsedMs: number,
  cacheHit: boolean,
): Record<string, unknown> {
  const firstFile = share.files[0];

  return {
    status: "success",
    response_time: `${(elapsedMs / 1_000).toFixed(3)}s`,
    url: sourceUrl,
    surl: share.surl,
    cached: cacheHit,
    file_count: share.files.length,
    files: share.files.map(toPublicFile),
    // Keep the original API's first-item fields for existing clients.
    ...(firstFile && { filename: firstFile.name }),
    ...(firstFile?.sizeBytes !== undefined && { size: formatBytes(firstFile.sizeBytes) }),
    ...(firstFile?.download && { download: firstFile.download }),
    ...(firstFile?.thumbs && { thumbs: firstFile.thumbs }),
    timestamp: new Date().toISOString(),
  };
}

function dashboardData(resolver: ShareResolver, transferManager?: TransferStatusProvider): Record<string, unknown> {
  return {
    generated_at: new Date().toISOString(),
    cache_items: resolver.cacheSize,
    transfers: transferManager?.getDashboard?.() ?? transferManager?.getStatus() ?? { enabled: false },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
): Promise<void> {
  const { config, resolver, telegramBot, transferManager, logger = console } = options;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "OPTIONS") {
    response.writeHead(204, corsHeaders(config));
    response.end();
    return;
  }

  if (method !== "GET") {
    methodNotAllowed(response, config);
    return;
  }

  if (url.pathname === "/admin" || url.pathname === "/admin/status") {
    if (!config.adminApiKey) {
      writePrivateJson(response, 404, { status: "error", message: "Not found" });
      return;
    }
    if (!isAdminAuthorized(request, config.adminApiKey)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="TeraBox transfer dashboard"');
      writePrivateJson(response, 401, { status: "error", message: "Admin authorization required" });
      return;
    }

    const data = dashboardData(resolver, transferManager);
    if (url.pathname === "/admin/status") {
      writePrivateJson(response, 200, data);
    } else {
      const payload = escapeHtml(JSON.stringify(data, null, 2));
      writeHtml(response, 200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>TeraBox transfer dashboard</title>
<style>body{margin:0;background:#10131a;color:#e8edf5;font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:32px auto;padding:0 20px}h1{font-size:24px}p{color:#aab7c8}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#19202b;border:1px solid #2d394b;border-radius:10px;padding:20px}</style>
</head><body><main><h1>TeraBox transfer dashboard</h1><p>Auto-refreshes every 15 seconds. Keep this URL private.</p><pre>${payload}</pre></main></body></html>`);
    }
    return;
  }

  if (url.pathname === "/") {
    writeJson(response, config, 200, {
      name: "TeraBox Telegram Bot API",
      version: "2.2",
      status: "operational",
      endpoints: {
        "/api?url=<terabox-share-url>": "Resolve a TeraBox share URL",
        "/health": "Service health and Telegram polling status",
      },
      telegram_enabled: Boolean(telegramBot),
      telegram_upload_enabled: Boolean(transferManager),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/health") {
    writeJson(response, config, 200, {
      status: "ok",
      cache_items: resolver.cacheSize,
      telegram: telegramBot ? telegramBot.getStatus() : { enabled: false },
      transfers: transferManager ? transferManager.getStatus() : { enabled: false },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname !== "/api") {
    writeJson(response, config, 404, { status: "error", message: "Not found" });
    return;
  }

  const targetUrl = url.searchParams.get("url")?.trim();
  if (!targetUrl) {
    writeJson(response, config, 400, {
      status: "error",
      message: "Missing required parameter: url",
      example: "/api?url=https://terabox.app/s/1HSEb8PZRUE7Z1Tvd3ZtT0g",
    });
    return;
  }

  if (targetUrl.length > 4_096 || !isValidShareUrl(targetUrl)) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl.slice(0, 512),
      message: "Invalid TeraBox share URL",
    });
    return;
  }

  const surl = extractSurl(targetUrl);
  if (!surl) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl,
      message: "Could not extract a TeraBox share identifier",
    });
    return;
  }

  const startedAt = Date.now();
  try {
    const { value: share, cacheHit } = await resolver.resolve(surl);
    writeJson(response, config, 200, successResponse(share, targetUrl, Date.now() - startedAt, cacheHit));
  } catch (error) {
    const statusCode = error instanceof TeraBoxError ? error.statusCode : 502;
    const message = error instanceof TeraBoxError ? error.message : "Unable to resolve the TeraBox share right now.";
    if (!(error instanceof TeraBoxError)) {
      logger.error("[api] Unexpected resolver error", error);
    }
    writeJson(response, config, statusCode, {
      status: "error",
      url: targetUrl,
      surl,
      message,
      response_time: `${((Date.now() - startedAt) / 1_000).toFixed(3)}s`,
      timestamp: new Date().toISOString(),
    });
  }
}

export function createApiServer(options: ApiServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      options.logger?.error("[api] Unhandled request error", error);
      if (!response.headersSent) {
        writeJson(response, options.config, 500, {
          status: "error",
          message: "Internal server error",
        });
      } else {
        response.destroy();
      }
    });
  });
}
