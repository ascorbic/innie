/**
 * Telegram Long-Polling Integration for Innie Scheduler
 *
 * Handles incoming Telegram messages and routes them to OpenCode sessions.
 * Supports interrupt-and-resume: if a session is busy, it can be interrupted
 * before sending the new message.
 *
 * Environment variables:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather (required)
 * - TELEGRAM_CHAT_ID: Allowed chat ID for security (optional, recommended)
 */

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
    photo?: Array<{ file_id: string }>;
    document?: { file_id: string; file_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

interface TelegramResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

interface SessionStatus {
  id: string;
  title?: string;
  busy: boolean;
}

type LogFn = (message: string) => void;
type LogErrorFn = (message: string, error?: unknown) => void;

export interface TelegramConfig {
  botToken: string;
  chatId?: number;
  opencodeUrl: string;
  getAuthHeader: () => Record<string, string>;
  log: LogFn;
  logError: LogErrorFn;
}

export class TelegramPoller {
  private config: TelegramConfig;
  private lastUpdateId = 0;
  private isRunning = false;
  private abortController: AbortController | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  /**
   * Start the long-polling loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.config.log("[Telegram] Already running");
      return;
    }

    this.isRunning = true;
    this.config.log("[Telegram] Starting long-polling...");

    while (this.isRunning) {
      try {
        await this.poll();
      } catch (error) {
        if (this.isRunning) {
          this.config.logError("[Telegram] Poll error, retrying in 5s:", error);
          await this.sleep(5000);
        }
      }
    }
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    this.config.log("[Telegram] Stopping...");
    this.isRunning = false;
    this.abortController?.abort();
  }

  /**
   * Single poll iteration with long-polling timeout
   */
  private async poll(): Promise<void> {
    this.abortController = new AbortController();
    const timeout = 30; // Telegram will hold connection for up to 30s

    try {
      const url = new URL(
        `https://api.telegram.org/bot${this.config.botToken}/getUpdates`
      );
      url.searchParams.set("timeout", timeout.toString());
      url.searchParams.set("offset", (this.lastUpdateId + 1).toString());
      url.searchParams.set("allowed_updates", JSON.stringify(["message", "callback_query"]));

      const response = await fetch(url.toString(), {
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.status}`);
      }

      const data = (await response.json()) as TelegramResponse;

      if (!data.ok) {
        throw new Error(`Telegram error: ${data.description}`);
      }

      if (data.result && data.result.length > 0) {
        for (const update of data.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Expected when stopping
        return;
      }
      throw error;
    }
  }

  /**
   * Handle a single Telegram update
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    // Handle callback queries (button presses)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message?.text) {
      return; // Ignore non-text messages for now
    }

    // Security: only respond to allowed chat
    if (this.config.chatId && message.chat.id !== this.config.chatId) {
      this.config.log(
        `[Telegram] Ignoring message from unauthorized chat: ${message.chat.id}`
      );
      return;
    }

    this.config.log(
      `[Telegram] Message from ${message.from.username || message.from.first_name}: ${message.text.slice(0, 50)}...`
    );

    await this.routeToOpencode(message.text, message.chat.id);
  }

  /**
   * Handle callback query (button press)
   */
  private async handleCallbackQuery(query: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  }): Promise<void> {
    // Acknowledge the callback
    await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: query.id }),
      }
    );

    if (query.data && query.message) {
      this.config.log(`[Telegram] Callback: ${query.data}`);
      await this.routeToOpencode(
        `[Button pressed: ${query.data}]`,
        query.message.chat.id
      );
    }
  }

  /**
   * Route a message to OpenCode, handling interrupts
   */
  private async routeToOpencode(text: string, chatId: number): Promise<void> {
    try {
      // Check if OpenCode is available
      const healthRes = await fetch(`${this.config.opencodeUrl}/global/health`, {
        headers: this.config.getAuthHeader(),
      });

      if (!healthRes.ok) {
        await this.sendTelegramMessage(
          chatId,
          "⚠️ OpenCode server is not available"
        );
        return;
      }

      // Get or create Telegram session
      const sessionId = await this.getOrCreateSession("Telegram");

      // Check if session is busy
      const isBusy = await this.isSessionBusy(sessionId);

      if (isBusy) {
        this.config.log(`[Telegram] Session ${sessionId} is busy, aborting...`);
        await this.abortSession(sessionId);
        // Brief pause to let abort complete
        await this.sleep(500);
      }

      // Format the message with context
      const now = new Date().toLocaleString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      const payload = `[Telegram message received]\nTime: ${now}\n\n${text}`;

      // Send to OpenCode
      const res = await fetch(
        `${this.config.opencodeUrl}/session/${sessionId}/prompt_async`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.config.getAuthHeader(),
          },
          body: JSON.stringify({
            parts: [{ type: "text", text: payload }],
          }),
        }
      );

      if (res.ok) {
        this.config.log(`[Telegram] Sent to session ${sessionId}`);
      } else {
        this.config.logError(
          `[Telegram] Failed to send: ${res.status} ${res.statusText}`
        );
        await this.sendTelegramMessage(chatId, "⚠️ Failed to process message");
      }
    } catch (error) {
      this.config.logError("[Telegram] Error routing message:", error);
    }
  }

  /**
   * Get or create a named session
   */
  private async getOrCreateSession(title: string): Promise<string> {
    // List existing sessions
    const listRes = await fetch(`${this.config.opencodeUrl}/session`, {
      headers: this.config.getAuthHeader(),
    });

    if (!listRes.ok) {
      throw new Error(`Failed to list sessions: ${listRes.status}`);
    }

    const sessions = (await listRes.json()) as SessionStatus[];

    // Look for existing session with this title
    const existing = sessions.find((s) => s.title === title);
    if (existing) {
      return existing.id;
    }

    // Create new session
    const createRes = await fetch(`${this.config.opencodeUrl}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.getAuthHeader(),
      },
      body: JSON.stringify({ title }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create session: ${createRes.status}`);
    }

    const newSession = (await createRes.json()) as { id: string };
    this.config.log(`[Telegram] Created new session: ${newSession.id}`);
    return newSession.id;
  }

  /**
   * Check if a session is currently busy
   */
  private async isSessionBusy(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.opencodeUrl}/session/status`, {
        headers: this.config.getAuthHeader(),
      });

      if (!res.ok) {
        return false;
      }

      const statuses = (await res.json()) as Record<string, { busy: boolean }>;
      return statuses[sessionId]?.busy ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Abort a running session
   */
  private async abortSession(sessionId: string): Promise<void> {
    try {
      const res = await fetch(
        `${this.config.opencodeUrl}/session/${sessionId}/abort`,
        {
          method: "POST",
          headers: this.config.getAuthHeader(),
        }
      );

      if (res.ok) {
        this.config.log(`[Telegram] Aborted session ${sessionId}`);
      }
    } catch (error) {
      this.config.logError("[Telegram] Failed to abort session:", error);
    }
  }

  /**
   * Send a message via Telegram API
   */
  private async sendTelegramMessage(
    chatId: number,
    text: string
  ): Promise<void> {
    await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      }
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create and start a Telegram poller if configured
 */
export function createTelegramPoller(
  config: Omit<TelegramConfig, "botToken" | "chatId">
): TelegramPoller | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    config.log("[Telegram] No TELEGRAM_BOT_TOKEN set, skipping Telegram integration");
    return null;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID
    ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
    : undefined;

  if (chatId) {
    config.log(`[Telegram] Restricted to chat ID: ${chatId}`);
  } else {
    config.log("[Telegram] Warning: No TELEGRAM_CHAT_ID set - bot will respond to any chat");
  }

  return new TelegramPoller({
    ...config,
    botToken,
    chatId,
  });
}
