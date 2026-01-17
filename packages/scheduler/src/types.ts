/**
 * Shared types for the scheduler package
 */

export interface ScheduledReminder {
  id: string;
  type: "cron" | "once";
  schedule: string;
  description: string;
  payload: string;
  createdAt: string;
  lastRun?: string;
  model?: string;
}

export interface SchedulerConfig {
  memoryDir: string;
  remindersDir: string;
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
}
