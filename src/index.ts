import "dotenv/config";
import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { ExpiringCache } from "./lib/cache.js";
import { CachedShareService } from "./lib/share-service.js";
import { TelegramBot } from "./lib/telegram.js";
import { type ResolvedShare, TeraBoxClient } from "./lib/terabox.js";
import type { TransferManager } from "./lib/transfer.js";
import { createApiServer } from "./server.js";

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TeraBoxClient({
    cookies: config.terabox.cookies,
    requestTimeoutMs: config.terabox.requestTimeoutMs,
  });
  const cache = new ExpiringCache<ResolvedShare>(config.cacheTtlMs, config.cacheMaxItems);
  const resolver = new CachedShareService(client, cache);
  let transferManager: TransferManager | undefined;
  if (config.transfer && config.telegram) {
    const [{ TransferManager }, { MtprotoBotUploader }] = await Promise.all([
      import("./lib/transfer.js"),
      import("./lib/mtproto-uploader.js"),
    ]);
    transferManager = new TransferManager({
      config: config.transfer,
      resolver,
      cookies: config.terabox.cookies,
      uploader: new MtprotoBotUploader(config.telegram, config.transfer),
    });
  }
  const telegramBot = config.telegram
    ? new TelegramBot({ config: config.telegram, resolver, transferManager })
    : undefined;
  const server = createApiServer({ config, resolver, telegramBot, transferManager });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`[server] ${signal} received; shutting down.`);

    try {
      await Promise.all([telegramBot?.stop(), transferManager?.stop(), closeServer(server)]);
      process.exitCode = 0;
    } catch (error) {
      console.error("[server] Graceful shutdown failed", error);
      process.exitCode = 1;
    }
  };

  server.once("error", (error) => {
    console.error("[server] Failed to start", error);
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    console.info(`[server] API listening on http://${config.host}:${config.port}`);
    if (telegramBot) {
      telegramBot.start();
    } else {
      console.info("[telegram] Disabled. Set TELEGRAM_BOT_TOKEN to enable the bot.");
    }
  });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error("[server] Startup configuration error", error);
  process.exitCode = 1;
});
