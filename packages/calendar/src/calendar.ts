/**
 * Calendar.app queries via AppleScript
 */

import { runAppleScriptFile, parseAppleScriptList } from "./applescript.js";

export interface CalendarInfo {
  name: string;
  id: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  startDate: string;
  endDate: string;
  location?: string;
  description?: string;
  allDay: boolean;
  calendar: string;
}

/**
 * List all calendars
 */
export async function listCalendars(): Promise<CalendarInfo[]> {
  const script = `
tell application "Calendar"
  set output to ""
  repeat with cal in calendars
    set output to output & (uid of cal) & "|||" & (name of cal) & "\\n"
  end repeat
  return output
end tell
`;
  const result = await runAppleScriptFile(script);
  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const [id, name] = line.split("|||");
    return { id: id?.trim() || "", name: name?.trim() || "" };
  });
}

/**
 * Get events within a date range
 */
export async function getEvents(
  startDate: Date,
  endDate: Date,
  calendarNames?: string[]
): Promise<CalendarEvent[]> {
  // Format dates for AppleScript comparison
  const startStr = formatAppleScriptDate(startDate);
  const endStr = formatAppleScriptDate(endDate);

  const calendarFilter = calendarNames?.length
    ? `whose name is in {${calendarNames.map(n => `"${n}"`).join(", ")}}`
    : "";

  const script = `
tell application "Calendar"
  set startDate to date "${startStr}"
  set endDate to date "${endStr}"
  set output to ""

  repeat with cal in (calendars ${calendarFilter})
    set calName to name of cal
    set calEvents to (every event of cal whose start date >= startDate and start date <= endDate)

    repeat with evt in calEvents
      set evtId to uid of evt
      set evtSummary to summary of evt
      set evtStart to start date of evt
      set evtEnd to end date of evt
      set evtAllDay to allday event of evt
      set evtLocation to ""
      set evtDescription to ""

      try
        set evtLocation to location of evt
      end try
      try
        set evtDescription to description of evt
      end try

      set output to output & evtId & "|||" & evtSummary & "|||" & (evtStart as string) & "|||" & (evtEnd as string) & "|||" & evtAllDay & "|||" & evtLocation & "|||" & evtDescription & "|||" & calName & "\\n"
    end repeat
  end repeat

  return output
end tell
`;

  const result = await runAppleScriptFile(script);
  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const parts = line.split("|||");
    return {
      id: parts[0]?.trim() || "",
      summary: parts[1]?.trim() || "",
      startDate: parseDate(parts[2]?.trim() || ""),
      endDate: parseDate(parts[3]?.trim() || ""),
      allDay: parts[4]?.trim() === "true",
      location: parts[5]?.trim() || undefined,
      description: parts[6]?.trim() || undefined,
      calendar: parts[7]?.trim() || "",
    };
  }).sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
}

/**
 * Get today's events
 */
export async function getTodayEvents(calendarNames?: string[]): Promise<CalendarEvent[]> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  return getEvents(start, end, calendarNames);
}

/**
 * Get upcoming events (next N hours)
 */
export async function getUpcomingEvents(
  hoursAhead: number = 24,
  calendarNames?: string[]
): Promise<CalendarEvent[]> {
  const start = new Date();
  const end = new Date(start.getTime() + hoursAhead * 60 * 60 * 1000);

  return getEvents(start, end, calendarNames);
}

/**
 * Create a new event
 */
export async function createEvent(
  calendarName: string,
  summary: string,
  startDate: Date,
  endDate: Date,
  options: {
    location?: string;
    description?: string;
    allDay?: boolean;
  } = {}
): Promise<string> {
  const startStr = formatAppleScriptDate(startDate);
  const endStr = formatAppleScriptDate(endDate);

  const script = `
tell application "Calendar"
  tell calendar "${calendarName}"
    set newEvent to make new event with properties {summary:"${escapeAppleScriptString(summary)}", start date:date "${startStr}", end date:date "${endStr}"${options.allDay ? ", allday event:true" : ""}${options.location ? `, location:"${escapeAppleScriptString(options.location)}"` : ""}${options.description ? `, description:"${escapeAppleScriptString(options.description)}"` : ""}}
    return uid of newEvent
  end tell
end tell
`;

  return await runAppleScriptFile(script);
}

/**
 * Delete an event
 */
export async function deleteEvent(eventId: string, calendarName: string): Promise<void> {
  const script = `
tell application "Calendar"
  tell calendar "${calendarName}"
    delete (first event whose uid is "${eventId}")
  end tell
end tell
`;
  await runAppleScriptFile(script);
}

// Helper to format date for AppleScript
function formatAppleScriptDate(date: Date): string {
  // Format: "January 7, 2026 10:00:00 AM"
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

// Helper to parse AppleScript date to ISO
function parseDate(dateStr: string): string {
  if (!dateStr) return new Date().toISOString();
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// Helper to escape strings for AppleScript
function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
