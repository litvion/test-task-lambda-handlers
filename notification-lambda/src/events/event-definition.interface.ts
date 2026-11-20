import type { z } from 'zod';
import type { EventType } from '../enums/event-type.enum.js';
import type { NotificationType } from '../enums/notification-type.enum.js';

export type EventData = Record<string, unknown> & { event_id?: string };

export interface EventDefinition {
  type: EventType;
  notificationTypeId: NotificationType;
  schema: z.ZodType<EventData>;
}
