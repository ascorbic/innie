#!/usr/bin/env node
/**
 * Calendar MCP Server for Innie
 *
 * Uses AppleScript to query Calendar.app on macOS.
 * Provides read/write access to local calendars.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  listCalendars,
  getEvents,
  getTodayEvents,
  getUpcomingEvents,
  createEvent,
  deleteEvent,
  type CalendarEvent,
} from "./calendar.js";

const server = new Server(
  {
    name: "innie-calendar",
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
      name: "list_calendars",
      description: "List all calendars available in Calendar.app",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_today_events",
      description: "Get all events for today",
      inputSchema: {
        type: "object",
        properties: {
          calendars: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific calendar names (optional)",
          },
        },
      },
    },
    {
      name: "get_upcoming_events",
      description: "Get upcoming events within a time window",
      inputSchema: {
        type: "object",
        properties: {
          hoursAhead: {
            type: "number",
            description: "Hours to look ahead (default: 24)",
            default: 24,
          },
          calendars: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific calendar names (optional)",
          },
        },
      },
    },
    {
      name: "get_events_in_range",
      description: "Get events within a specific date range",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "Start date in ISO 8601 format",
          },
          endDate: {
            type: "string",
            description: "End date in ISO 8601 format",
          },
          calendars: {
            type: "array",
            items: { type: "string" },
            description: "Filter to specific calendar names (optional)",
          },
        },
        required: ["startDate", "endDate"],
      },
    },
    {
      name: "create_event",
      description: "Create a new calendar event",
      inputSchema: {
        type: "object",
        properties: {
          calendar: {
            type: "string",
            description: "Name of the calendar to add the event to",
          },
          summary: {
            type: "string",
            description: "Event title/summary",
          },
          startDate: {
            type: "string",
            description: "Start date/time in ISO 8601 format",
          },
          endDate: {
            type: "string",
            description: "End date/time in ISO 8601 format",
          },
          location: {
            type: "string",
            description: "Event location (optional)",
          },
          description: {
            type: "string",
            description: "Event description/notes (optional)",
          },
          allDay: {
            type: "boolean",
            description: "Whether this is an all-day event (default: false)",
            default: false,
          },
        },
        required: ["calendar", "summary", "startDate", "endDate"],
      },
    },
    {
      name: "delete_event",
      description: "Delete a calendar event by ID",
      inputSchema: {
        type: "object",
        properties: {
          eventId: {
            type: "string",
            description: "The event's unique ID",
          },
          calendar: {
            type: "string",
            description: "Name of the calendar containing the event",
          },
        },
        required: ["eventId", "calendar"],
      },
    },
  ],
}));

// Format events for display
function formatEvents(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return "(no events found)";
  }

  return events.map(evt => {
    const start = new Date(evt.startDate);
    const end = new Date(evt.endDate);

    const timeStr = evt.allDay
      ? "All day"
      : `${start.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} - ${end.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

    const dateStr = start.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });

    const parts = [
      `**${evt.summary}**`,
      `  ${dateStr}, ${timeStr}`,
      `  Calendar: ${evt.calendar}`,
    ];

    if (evt.location) parts.push(`  Location: ${evt.location}`);
    if (evt.description) parts.push(`  Notes: ${evt.description.slice(0, 100)}${evt.description.length > 100 ? "..." : ""}`);
    parts.push(`  ID: ${evt.id}`);

    return parts.join("\n");
  }).join("\n\n");
}

// Tool implementations
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_calendars": {
        const calendars = await listCalendars();
        if (calendars.length === 0) {
          return {
            content: [{ type: "text", text: "(no calendars found - is Calendar.app running?)" }],
          };
        }
        const formatted = calendars
          .map(c => `- ${c.name} (${c.id})`)
          .join("\n");
        return {
          content: [{ type: "text", text: `**Calendars:**\n${formatted}` }],
        };
      }

      case "get_today_events": {
        const { calendars } = args as { calendars?: string[] };
        const events = await getTodayEvents(calendars);
        return {
          content: [{ type: "text", text: `**Today's Events:**\n\n${formatEvents(events)}` }],
        };
      }

      case "get_upcoming_events": {
        const { hoursAhead, calendars } = args as {
          hoursAhead?: number;
          calendars?: string[];
        };
        const events = await getUpcomingEvents(hoursAhead ?? 24, calendars);
        return {
          content: [{ type: "text", text: `**Upcoming Events (next ${hoursAhead ?? 24}h):**\n\n${formatEvents(events)}` }],
        };
      }

      case "get_events_in_range": {
        const { startDate, endDate, calendars } = args as {
          startDate: string;
          endDate: string;
          calendars?: string[];
        };
        const events = await getEvents(
          new Date(startDate),
          new Date(endDate),
          calendars
        );
        return {
          content: [{ type: "text", text: `**Events:**\n\n${formatEvents(events)}` }],
        };
      }

      case "create_event": {
        const { calendar, summary, startDate, endDate, location, description, allDay } =
          args as {
            calendar: string;
            summary: string;
            startDate: string;
            endDate: string;
            location?: string;
            description?: string;
            allDay?: boolean;
          };

        const eventId = await createEvent(
          calendar,
          summary,
          new Date(startDate),
          new Date(endDate),
          { location, description, allDay }
        );

        return {
          content: [
            {
              type: "text",
              text: `Event created: "${summary}" on ${new Date(startDate).toLocaleDateString("en-GB")} (ID: ${eventId})`,
            },
          ],
        };
      }

      case "delete_event": {
        const { eventId, calendar } = args as {
          eventId: string;
          calendar: string;
        };

        await deleteEvent(eventId, calendar);
        return {
          content: [{ type: "text", text: `Event deleted (ID: ${eventId})` }],
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
  console.error("[Calendar] MCP server started");
}

main().catch((error) => {
  console.error("[Calendar] Fatal error:", error);
  process.exit(1);
});
