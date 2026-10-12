import { webhookCallback } from "grammy";
import { Env } from "./types";
import { getBot } from "./bot/bot";
import { runCronMonitor } from "./cron/monitor";
import { ensureDatabaseSchema } from "./db/queries";
import { executionContextStorage } from "./utils/background";

export * from "./types";
export * from "./config";
export { getBot } from "./bot/bot";
export { runCronMonitor } from "./cron/monitor";
export { ensureDatabaseSchema } from "./db/queries";

let cachedWebhookHandler: ((req: Request) => Promise<Response>) | null = null;

export async function handleBotWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (env.TELEGRAM_SECRET_TOKEN) {
    const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (headerSecret !== env.TELEGRAM_SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 403 });
    }
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return new Response("Bot token not configured", { status: 503 });
  }

  const url = new URL(request.url);
  if (!env.WEBAPP_URL && url.protocol === "https:") {
    env.WEBAPP_URL = url.origin;
  }

  const bot = getBot(env);
  if (!cachedWebhookHandler) {
    cachedWebhookHandler = webhookCallback(bot, "cloudflare-mod");
  }
  return await executionContextStorage.run(ctx, () => cachedWebhookHandler!(request as any));
}

export async function setupBotCommands(
  env: Env,
  originUrl?: string,
): Promise<{
  ok: boolean;
  message: string;
  webAppUrl: string | null;
  webhookUrl: string | null;
}> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  if (!env.WEBAPP_URL && originUrl && originUrl.startsWith("https:")) {
    env.WEBAPP_URL = originUrl;
  }

  await ensureDatabaseSchema(env.DB);
  const bot = getBot(env);
  await bot.api.setMyCommands([
    { command: "positions", description: "📊 Открытые сделки и риски" },
    { command: "list", description: "💼 Список ваших кошельков" },
    { command: "threshold", description: "⚙️ Настройка шага цены для алертов" },
    { command: "settings", description: "⚙️ Параметры уведомлений и тихий сон" },
    { command: "help", description: "ℹ️ Справка и возможности" },
    { command: "stats", description: "📊 Системный дашборд (админ)" },
    { command: "add_rh", description: "➕ Добавить аккаунт Robinhood Lighter" },
    { command: "add_mainnet", description: "➕ Добавить аккаунт Lighter Mainnet" },
    { command: "remove_rh", description: "➖ Удалить аккаунт Robinhood Lighter" },
    { command: "remove_mainnet", description: "➖ Удалить аккаунт Lighter Mainnet" },
    { command: "start", description: "🚀 Главное меню" },
  ]);

  let menuButtonConfigured = false;
  const webAppUrl = (env.WEBAPP_URL || originUrl || "").trim().replace(/\/$/, "");
  if (webAppUrl && webAppUrl.startsWith("https://")) {
    await bot.api.setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "🚀 Web App",
        web_app: { url: webAppUrl },
      },
    });
    menuButtonConfigured = true;
  }

  let webhookConfigured = false;
  let webhookUrl: string | null = null;
  if (originUrl && originUrl.startsWith("https:")) {
    try {
      webhookUrl = `${originUrl}/webhook`;
      await bot.api.setWebhook(webhookUrl, {
        secret_token: env.TELEGRAM_SECRET_TOKEN,
      });
      webhookConfigured = true;
    } catch (e) {
      console.error("Failed to set webhook in setupBotCommands:", e);
    }
  }

  return {
    ok: true,
    message: "Commands, Menu Button, and Webhook registered successfully in Telegram",
    webAppUrl: menuButtonConfigured ? webAppUrl : null,
    webhookUrl: webhookConfigured ? webhookUrl : null,
  };
}

export async function runBotScheduled(
  event: ScheduledEvent | null,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  await runCronMonitor(env, ctx);
}
