#!/usr/bin/env node
/**
 * Telegram MCP Server for Innie
 *
 * Provides tools for sending messages, files, and photos via Telegram.
 *
 * Environment variables:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather (required)
 * - TELEGRAM_CHAT_ID: Target chat ID for sending messages (required)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import FormData from "form-data";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error("[Telegram] Error: TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("[Telegram] Error: TELEGRAM_CHAT_ID not set");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send a request to the Telegram API
 */
async function telegramRequest(
  method: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json() as Promise<{
    ok: boolean;
    description?: string;
    result?: unknown;
  }>;
}

/**
 * Send a file using multipart/form-data
 */
async function sendFileMultipart(
  method: string,
  fieldName: string,
  filePath: string,
  caption?: string
): Promise<{ ok: boolean; description?: string }> {
  const form = new FormData();
  form.append("chat_id", CHAT_ID!);
  form.append(fieldName, createReadStream(filePath), basename(filePath));
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
  }

  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    // @ts-expect-error - FormData headers work with fetch
    headers: form.getHeaders(),
    // @ts-expect-error - FormData works as body
    body: form,
  });

  return response.json() as Promise<{ ok: boolean; description?: string }>;
}

const server = new Server(
  {
    name: "innie-telegram",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_telegram",
      description:
        "Send a message to the user via Telegram. IMPORTANT: Always format URLs as markdown links [text](url) – especially URLs with underscores, which break in plain text rendering.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description:
              "The message to send. Use markdown formatting, especially [text](url) for links.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "send_telegram_file",
      description: "Send a file/document to the user via Telegram",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the file to send",
          },
          caption: {
            type: "string",
            description: "Optional caption for the file",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "send_telegram_photo",
      description: "Send a photo/image to the user via Telegram",
      inputSchema: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description: "Absolute path to the image file to send",
          },
          caption: {
            type: "string",
            description: "Optional caption for the photo",
          },
        },
        required: ["filePath"],
      },
    },
    {
      name: "send_telegram_keyboard",
      description: "Send a message with inline keyboard buttons for quick actions",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to send",
          },
          buttons: {
            type: "array",
            description: "Array of button definitions",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                callbackData: { type: "string" },
              },
              required: ["text", "callbackData"],
            },
          },
        },
        required: ["message", "buttons"],
      },
    },
  ],
}));

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send_telegram": {
        const { message } = args as { message: string };
        const result = await telegramRequest("sendMessage", {
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        });

        if (!result.ok) {
          return {
            content: [
              { type: "text", text: `Failed to send: ${result.description}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: "text", text: `Sent message to Telegram (${message.length} chars)` },
          ],
        };
      }

      case "send_telegram_file": {
        const { filePath, caption } = args as {
          filePath: string;
          caption?: string;
        };

        // Check file exists
        try {
          await stat(filePath);
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${filePath}` }],
            isError: true,
          };
        }

        const result = await sendFileMultipart(
          "sendDocument",
          "document",
          filePath,
          caption
        );

        if (!result.ok) {
          return {
            content: [
              { type: "text", text: `Failed to send file: ${result.description}` },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Sent file: ${filePath}` }],
        };
      }

      case "send_telegram_photo": {
        const { filePath, caption } = args as {
          filePath: string;
          caption?: string;
        };

        // Check file exists
        try {
          await stat(filePath);
        } catch {
          return {
            content: [{ type: "text", text: `File not found: ${filePath}` }],
            isError: true,
          };
        }

        const result = await sendFileMultipart(
          "sendPhoto",
          "photo",
          filePath,
          caption
        );

        if (!result.ok) {
          return {
            content: [
              { type: "text", text: `Failed to send photo: ${result.description}` },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Sent photo: ${filePath}` }],
        };
      }

      case "send_telegram_keyboard": {
        const { message, buttons } = args as {
          message: string;
          buttons: Array<{ text: string; callbackData: string }>;
        };

        const keyboard = {
          inline_keyboard: [
            buttons.map((btn) => ({
              text: btn.text,
              callback_data: btn.callbackData,
            })),
          ],
        };

        const result = await telegramRequest("sendMessage", {
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });

        if (!result.ok) {
          return {
            content: [
              { type: "text", text: `Failed to send: ${result.description}` },
            ],
            isError: true,
          };
        }

        return {
          content: [
            { type: "text", text: `Sent message with ${buttons.length} button(s)` },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Telegram] MCP server started");
}

main().catch((error) => {
  console.error("[Telegram] Fatal error:", error);
  process.exit(1);
});
