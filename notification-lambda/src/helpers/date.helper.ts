import { UTCDate } from '@date-fns/utc';
import { isValid, parse, subMinutes } from 'date-fns';

// Explicit formats only: new Date(string) guesses ambiguous input like 01/02/2021
// and silently rolls 2021-02-30 over to March 2.
const FORMATS = [
  'yyyy-MM-dd',
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd'T'HH:mm:ssXXX",
  "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
  'yyyy/MM/dd HH:mmXXX',
  'MMMM do, yyyy HH:mm',
  'MMMM d, yyyy HH:mm',
];

// Zone abbreviations as fixed offsets in minutes (PST is always -08:00).
// Ambiguous ones like IST are left out, so dates using them are rejected.
const ZONE_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  WEST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  MSK: 180,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AKST: -540,
  AKDT: -480,
  HST: -600,
  JST: 540,
  KST: 540,
  AEST: 600,
  AEDT: 660,
};

const TRAILING_ZONE = /^(.*\d) ([A-Za-z]{1,5})$/;

export type DateResult = { ok: true; iso: string } | { ok: false; reason: string };

export class DateHelper {
  static normalize(input: string): DateResult {
    const text = input.trim().replace(/\s+/g, ' ');

    if (!text) return { ok: false, reason: 'is empty' };

    const match = TRAILING_ZONE.exec(text);
    const zone = match?.[2];
    const date = DateHelper.parseDateTime(match ? match[1]! : text);

    if (!date) return { ok: false, reason: `"${text}" is not a valid date in a supported format` };

    const offsetMinutes = zone === undefined ? 0 : ZONE_OFFSETS[zone.toUpperCase()];

    if (offsetMinutes === undefined) {
      return { ok: false, reason: `"${text}" is not a valid date: unknown time zone "${zone}"` };
    }

    // The wall-clock time was parsed as UTC; shift it by the zone offset to get the instant.
    return { ok: true, iso: subMinutes(date, offsetMinutes).toISOString() };
  }

  private static parseDateTime(dateTime: string): Date | null {
    for (const format of FORMATS) {
      // A UTCDate reference makes zone-less input UTC, whatever the server's time zone is.
      const date = parse(dateTime, format, new UTCDate(0));

      if (isValid(date)) return date;
    }

    return null;
  }
}
