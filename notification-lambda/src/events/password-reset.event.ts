import { z } from 'zod';
import { EventType } from '../enums/event-type.enum.js';
import { NotificationType } from '../enums/notification-type.enum.js';
import { dateSchema, emailSchema, eventIdSchema } from '../schemas/fields.schema.js';
import type { EventDefinition } from './event-definition.interface.js';

export const passwordResetEvent: EventDefinition = {
  type: EventType.PasswordReset,
  notificationTypeId: NotificationType.PasswordReset,
  schema: z.object({
    event_id: eventIdSchema,
    email: emailSchema,
    requested: dateSchema,
  }),
};
