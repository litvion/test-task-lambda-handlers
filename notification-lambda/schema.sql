-- Reference schema (not executed by the Lambda; the database is simulated).

CREATE TABLE `NotificationType` (
  `NotificationTypeID` TINYINT UNSIGNED NOT NULL,
  `Name` VARCHAR(64) NOT NULL,
  PRIMARY KEY (`NotificationTypeID`),
  UNIQUE KEY `uq_notification_type_name` (`Name`)
);

-- Must stay in sync with src/enums/notification-type.enum.ts (test/events.test.ts checks it).
INSERT INTO `NotificationType` (`NotificationTypeID`, `Name`) VALUES
  (1, 'user_registered'),
  (2, 'password_reset'),
  (3, 'user_deleted');

CREATE TABLE `Notification` (
  `NotificationID` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `Created` DATETIME DEFAULT CURRENT_TIMESTAMP,          -- set by MySQL on insert (UTC)
  `Status` TINYINT UNSIGNED NOT NULL DEFAULT '0' COMMENT '0 = inbox, 1 = archived, 2 = deleted',
  `NotificationTypeID` TINYINT UNSIGNED NOT NULL COMMENT 'Global values. See NotificationType table',
  `NotificationData` JSON DEFAULT NULL,
  `CreatedByType` TINYINT UNSIGNED NOT NULL,
  `CreatedByID` INT UNSIGNED NOT NULL,
  `Seen` TINYINT UNSIGNED NOT NULL DEFAULT '0' COMMENT '0 = unseen, 1 = seen',
  `IsBookmarked` TINYINT UNSIGNED NOT NULL DEFAULT '0' COMMENT '0 = no, 1 = yes',
  PRIMARY KEY (`NotificationID`),
  KEY `idx_notification_type` (`NotificationTypeID`),
  CONSTRAINT `fk_notification_type` FOREIGN KEY (`NotificationTypeID`)
    REFERENCES `NotificationType` (`NotificationTypeID`)
);

-- Production note: to make inserts idempotent across Lambda invocations (not just within one
-- batch), persist the producer's event_id, e.g.
--   ALTER TABLE `Notification`
--     ADD `EventID` VARCHAR(128) GENERATED ALWAYS AS (`NotificationData`->>'$.event_id') STORED,
--     ADD UNIQUE KEY `uq_notification_event` (`EventID`);
-- and use INSERT ... ON DUPLICATE KEY UPDATE `NotificationID` = `NotificationID`.
