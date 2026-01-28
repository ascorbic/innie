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
 * - TELEGRAM_FILE_DIR: Directory to save downloaded files (default: /tmp/telegram-files)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE_DIR = process.env.TELEGRAM_FILE_DIR || "/tmp/telegram-files";

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

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
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
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

interface PendingPermission {
  sessionID: string;
  permissionID: string;
  permission: string;
  patterns: string[];
  always: string[];
}

export class TelegramPoller {
  private config: TelegramConfig;
  private lastUpdateId = 0;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private eventAbortController: AbortController | null = null;
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  /**
   * Start the long-polling loop and event stream subscription
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.config.log("[Telegram] Already running");
      return;
    }

    this.isRunning = true;
    this.config.log("[Telegram] Starting long-polling...");

    // Start event stream subscription for permission requests
    this.subscribeToEvents();

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
    this.eventAbortController?.abort();
  }

  /**
   * Subscribe to OpenCode event stream for permission requests
   */
  private async subscribeToEvents(): Promise<void> {
    while (this.isRunning) {
      try {
        this.eventAbortController = new AbortController();
        const response = await fetch(`${this.config.opencodeUrl}/event`, {
          headers: this.config.getAuthHeader(),
          signal: this.eventAbortController.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Event stream failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (this.isRunning) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6));
                await this.handleEvent(event);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        if (this.isRunning) {
          this.config.logError(
            "[Telegram] Event stream error, reconnecting in 5s:",
            error,
          );
          await this.sleep(5000);
        }
      }
    }
  }

  /**
   * Handle an event from the OpenCode event stream
   */
  private async handleEvent(event: {
    type: string;
    properties: Record<string, unknown>;
  }): Promise<void> {
    if (event.type === "permission.asked") {
      const props = event.properties as {
        id: string;
        sessionID: string;
        permission: string;
        patterns: string[];
        always: string[];
      };

      this.config.log(
        `[Telegram] Permission requested: ${props.permission} (${props.patterns.join(", ")})`,
      );

      // Store pending permission
      this.pendingPermissions.set(props.id, {
        sessionID: props.sessionID,
        permissionID: props.id,
        permission: props.permission,
        patterns: props.patterns,
        always: props.always,
      });

      // Send Telegram keyboard
      if (this.config.chatId) {
        await this.sendPermissionKeyboard(this.config.chatId, props);
      }
    }
  }

  /**
   * Send a permission request keyboard to Telegram
   */
  private async sendPermissionKeyboard(
    chatId: number,
    permission: {
      id: string;
      permission: string;
      patterns: string[];
      always: string[];
    },
  ): Promise<void> {
    const message = `🔐 *Permission Required*\n\n*Type:* \`${permission.permission}\`\n*Pattern:* \`${permission.patterns.join(", ")}\``;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "✅ Allow Once",
            callback_data: `perm:once:${permission.id}`,
          },
          { text: "✅ Always", callback_data: `perm:always:${permission.id}` },
        ],
        [{ text: "❌ Reject", callback_data: `perm:reject:${permission.id}` }],
      ],
    };

    await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
          reply_markup: keyboard,
        }),
      },
    );
  }

  /**
   * Respond to a permission request
   */
  private async respondToPermission(
    permissionID: string,
    response: "once" | "always" | "reject",
  ): Promise<boolean> {
    this.config.log(
      `[Telegram] Responding to permission ${permissionID} with ${response}`,
    );
    this.config.log(
      `[Telegram] Pending permissions: ${Array.from(this.pendingPermissions.keys()).join(", ")}`,
    );

    const pending = this.pendingPermissions.get(permissionID);
    if (!pending) {
      this.config.log(
        `[Telegram] Permission ${permissionID} not found in pending`,
      );
      return false;
    }

    try {
      const res = await fetch(
        `${this.config.opencodeUrl}/session/${pending.sessionID}/permissions/${permissionID}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.config.getAuthHeader(),
          },
          body: JSON.stringify({ response }),
        },
      );

      if (res.ok) {
        this.config.log(
          `[Telegram] Permission ${permissionID} responded: ${response}`,
        );
        this.pendingPermissions.delete(permissionID);
        return true;
      } else {
        this.config.logError(
          `[Telegram] Failed to respond to permission: ${res.status}`,
        );
        return false;
      }
    } catch (error) {
      this.config.logError("[Telegram] Error responding to permission:", error);
      return false;
    }
  }

  /**
   * Single poll iteration with long-polling timeout
   */
  private async poll(): Promise<void> {
    this.abortController = new AbortController();
    const timeout = 30; // Telegram will hold connection for up to 30s

    try {
      const url = new URL(
        `https://api.telegram.org/bot${this.config.botToken}/getUpdates`,
      );
      url.searchParams.set("timeout", timeout.toString());
      url.searchParams.set("offset", (this.lastUpdateId + 1).toString());
      url.searchParams.set(
        "allowed_updates",
        JSON.stringify(["message", "callback_query"]),
      );

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
    if (!message) {
      return;
    }

    // Security: only respond to allowed chat
    if (this.config.chatId && message.chat.id !== this.config.chatId) {
      this.config.log(
        `[Telegram] Ignoring message from unauthorized chat: ${message.chat.id}`,
      );
      return;
    }

    // Handle photos
    if (message.photo && message.photo.length > 0) {
      // Get the largest photo (last in array)
      const photo = message.photo[message.photo.length - 1];
      this.config.log(
        `[Telegram] Photo from ${message.from.username || message.from.first_name}${message.caption ? `: ${message.caption.slice(0, 30)}...` : ""}`,
      );
      await this.handleFileMessage(
        photo.file_id,
        message.caption,
        message.chat.id,
        "photo",
        `photo_${photo.file_unique_id}.jpg`,
      );
      return;
    }

    // Handle documents
    if (message.document) {
      this.config.log(
        `[Telegram] Document from ${message.from.username || message.from.first_name}: ${message.document.file_name || "unnamed"}`,
      );
      await this.handleFileMessage(
        message.document.file_id,
        message.caption,
        message.chat.id,
        "document",
        message.document.file_name || `doc_${message.document.file_unique_id}`,
      );
      return;
    }

    // Handle text messages
    if (message.text) {
      this.config.log(
        `[Telegram] Message from ${message.from.username || message.from.first_name}: ${message.text.slice(0, 50)}...`,
      );
      // Don't await - let it run in background so we can still process callbacks
      this.routeToOpencode(message.text, message.chat.id).catch((error) => {
        this.config.logError("[Telegram] Error routing message:", error);
      });
      return;
    }

    // Unsupported message type
    this.config.log(`[Telegram] Ignoring unsupported message type`);
  }

  /**
   * Handle a file (photo or document) message
   */
  private async handleFileMessage(
    fileId: string,
    caption: string | undefined,
    chatId: number,
    fileType: "photo" | "document",
    fileName: string,
  ): Promise<void> {
    try {
      // Download the file
      const localPath = await this.downloadFile(fileId, fileName);
      if (!localPath) {
        await this.sendTelegramMessage(chatId, "⚠️ Failed to download file");
        return;
      }

      // Route to OpenCode with file path
      const text = caption
        ? `[${fileType === "photo" ? "Photo" : "File"} received: ${fileName}]\nCaption: ${caption}\nSaved to: ${localPath}`
        : `[${fileType === "photo" ? "Photo" : "File"} received: ${fileName}]\nSaved to: ${localPath}`;

      // Don't await - let it run in background so we can still process callbacks
      this.routeToOpencodeWithFile(text, localPath, chatId).catch((error) => {
        this.config.logError("[Telegram] Error routing file message:", error);
      });
    } catch (error) {
      this.config.logError(`[Telegram] Error handling ${fileType}:`, error);
      await this.sendTelegramMessage(
        chatId,
        `⚠️ Failed to process ${fileType}`,
      );
    }
  }

  /**
   * Download a file from Telegram
   */
  private async downloadFile(
    fileId: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      // Get file info from Telegram
      const fileInfoRes = await fetch(
        `https://api.telegram.org/bot${this.config.botToken}/getFile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: fileId }),
        },
      );

      const fileInfo = (await fileInfoRes.json()) as {
        ok: boolean;
        result?: { file_path: string };
      };

      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        this.config.logError("[Telegram] Failed to get file info");
        return null;
      }

      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileInfo.result.file_path}`;
      const fileRes = await fetch(fileUrl);

      if (!fileRes.ok) {
        this.config.logError(
          `[Telegram] Failed to download file: ${fileRes.status}`,
        );
        return null;
      }

      // Ensure directory exists
      await mkdir(FILE_DIR, { recursive: true });

      // Save to disk with timestamp prefix to avoid collisions
      const timestamp = Date.now();
      const localPath = join(FILE_DIR, `${timestamp}_${fileName}`);
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      await writeFile(localPath, buffer);

      this.config.log(`[Telegram] Downloaded file to: ${localPath}`);
      return localPath;
    } catch (error) {
      this.config.logError("[Telegram] Error downloading file:", error);
      return null;
    }
  }

  /**
   * Handle callback query (button press)
   */
  private async handleCallbackQuery(query: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  }): Promise<void> {
    this.config.log(`[Telegram] Callback received: ${query.data}`);

    // Check if this is a permission response
    if (query.data?.startsWith("perm:")) {
      const [, response, permissionID] = query.data.split(":");
      this.config.log(
        `[Telegram] Permission callback: response=${response}, id=${permissionID}`,
      );
      if (response && permissionID) {
        const success = await this.respondToPermission(
          permissionID,
          response as "once" | "always" | "reject",
        );

        // Acknowledge and update the message
        const answerText = success
          ? `Permission ${response === "reject" ? "rejected" : "granted"}`
          : "Failed to respond to permission";

        await fetch(
          `https://api.telegram.org/bot${this.config.botToken}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callback_query_id: query.id,
              text: answerText,
            }),
          },
        );

        // Edit the original message to show the result
        if (query.message) {
          const resultEmoji = response === "reject" ? "❌" : "✅";
          const resultText =
            response === "reject"
              ? "Rejected"
              : response === "always"
                ? "Always allowed"
                : "Allowed once";
          await fetch(
            `https://api.telegram.org/bot${this.config.botToken}/editMessageText`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                text: `${resultEmoji} Permission ${resultText}`,
              }),
            },
          );
        }
        return;
      }
    }

    // Acknowledge the callback for non-permission buttons
    await fetch(
      `https://api.telegram.org/bot${this.config.botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: query.id }),
      },
    );

    if (query.data && query.message) {
      this.config.log(`[Telegram] Callback: ${query.data}`);
      await this.routeToOpencode(
        `[Button pressed: ${query.data}]`,
        query.message.chat.id,
      );
    }
  }

  /**
   * Route a message to OpenCode, handling interrupts
   */
  private async routeToOpencode(text: string, chatId: number): Promise<void> {
    try {
      // Check if OpenCode is available
      const healthRes = await fetch(
        `${this.config.opencodeUrl}/global/health`,
        {
          headers: this.config.getAuthHeader(),
        },
      );

      if (!healthRes.ok) {
        await this.sendTelegramMessage(
          chatId,
          "⚠️ OpenCode server is not available",
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

      const payload = `[Telegram message received]\nTime: ${now}\n\n${text}\n\nRespond using the send_telegram tool. Before ending the conversation, journal any significant work or decisions using the memory tools.`;

      // Send to OpenCode asynchronously
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
        },
      );

      if (res.ok) {
        this.config.log(`[Telegram] Sent to session ${sessionId}`);
      } else {
        this.config.logError(
          `[Telegram] Failed to send: ${res.status} ${res.statusText}`,
        );
        await this.sendTelegramMessage(chatId, "⚠️ Failed to process message");
      }
    } catch (error) {
      this.config.logError("[Telegram] Error routing message:", error);
    }
  }

  /**
   * Route a message with a file to OpenCode
   * The file path is included in the text so the agent can read it
   */
  private async routeToOpencodeWithFile(
    text: string,
    filePath: string,
    chatId: number,
  ): Promise<void> {
    try {
      // Check if OpenCode is available
      const healthRes = await fetch(
        `${this.config.opencodeUrl}/global/health`,
        {
          headers: this.config.getAuthHeader(),
        },
      );

      if (!healthRes.ok) {
        await this.sendTelegramMessage(
          chatId,
          "⚠️ OpenCode server is not available",
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

      const payload = `[Telegram message received]\nTime: ${now}\n\n${text}\n\nNote: Use the Read tool to view the file at the path above. Respond using the send_telegram tool. Before ending the conversation, journal any significant work or decisions using the memory tools.`;

      // Send to OpenCode asynchronously
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
        },
      );

      if (res.ok) {
        this.config.log(`[Telegram] Sent file message to session ${sessionId}`);
      } else {
        this.config.logError(
          `[Telegram] Failed to send: ${res.status} ${res.statusText}`,
        );
        await this.sendTelegramMessage(chatId, "⚠️ Failed to process file");
      }
    } catch (error) {
      this.config.logError("[Telegram] Error routing file message:", error);
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
        },
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
    text: string,
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
      },
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
  config: Omit<TelegramConfig, "botToken" | "chatId">,
): TelegramPoller | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    config.log(
      "[Telegram] No TELEGRAM_BOT_TOKEN set, skipping Telegram integration",
    );
    return null;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID
    ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
    : undefined;

  if (chatId) {
    config.log(`[Telegram] Restricted to chat ID: ${chatId}`);
  } else {
    config.log(
      "[Telegram] Warning: No TELEGRAM_CHAT_ID set - bot will respond to any chat",
    );
  }

  return new TelegramPoller({
    ...config,
    botToken,
    chatId,
  });
}
