import type { z } from 'zod';

export class ErrorHelper {
  static getMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  static formatZodIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => {
      const field = issue.path[0];

      return field === undefined ? issue.message : `${String(field)}: ${issue.message}`;
    });
  }

  static zodIssueFields(error: z.ZodError): string[] {
    return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? '(event)')))];
  }
}
