import { z } from 'zod';
import { EventType } from '../enums/event-type.enum.js';
import { NotificationType } from '../enums/notification-type.enum.js';
import { dateSchema, emailSchema, eventIdSchema } from '../schemas/fields.schema.js';
import type { EventDefinition } from './event-definition.interface.js';

export const userDeletedEvent: EventDefinition = {
  type: EventType.UserDeleted,
  notificationTypeId: NotificationType.UserDeleted,
  schema: z.object({
    event_id: eventIdSchema,
    email: emailSchema,
    deleted: dateSchema,
  }),
};
