import type { NotificationStatus } from '../enums/notification-status.enum.js';
import type { NotificationType } from '../enums/notification-type.enum.js';
import type { EventData } from '../events/event-definition.interface.js';

export interface NotificationRow {
  NotificationTypeID: NotificationType;
  NotificationData: EventData;
  Status: NotificationStatus;
  Seen: 0 | 1;
  IsBookmarked: 0 | 1;
  CreatedByType: number;
  CreatedByID: number;
}

export interface NotificationRepository {
  insertToMySQL(event: NotificationRow): Promise<{ notificationId: number }>;
}
