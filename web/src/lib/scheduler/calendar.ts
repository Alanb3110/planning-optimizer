import type { SchedulingProject } from "./types";

const WEEKDAY: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function parseClock(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid shift time '${value}'.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function dateKey(dateMs: number): string {
  return new Date(dateMs).toISOString().slice(0, 10);
}

function localParts(formatter: Intl.DateTimeFormat, instant: number): number[] {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute];
}

function localAsUtc(parts: number[]): number {
  return Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
}

function localBoundary(formatter: Intl.DateTimeFormat, wallMs: number, end: boolean): number {
  // Offsets on either side of the wall time cover both sides of a DST transition.
  const offsets = new Set([-DAY_MS, DAY_MS].map((delta) => {
    const probe = wallMs + delta;
    return localAsUtc(localParts(formatter, probe)) - probe;
  }));
  const candidates = [...offsets].map((offset) => wallMs - offset);
  const valid = candidates.filter((instant) => localAsUtc(localParts(formatter, instant)) === wallMs);
  if (valid.length) return end ? Math.max(...valid) : Math.min(...valid);
  // A nonexistent wall time is advanced to the first real time after the gap.
  const future = candidates.filter((instant) => localAsUtc(localParts(formatter, instant)) > wallMs);
  return Math.min(...(future.length ? future : candidates));
}

export function hourOffset(projectStart: string, value: string): number {
  const delta = (Date.parse(value) - Date.parse(projectStart)) / HOUR_MS;
  const rounded = Math.round(delta);
  if (!Number.isFinite(delta) || Math.abs(delta - rounded) > 1e-9) {
    throw new Error(`Date-time '${value}' is not aligned to the 1 h scheduling grid.`);
  }
  return rounded;
}

export function buildCalendarSlots(
  project: SchedulingProject,
  horizonH: number,
): Record<string, boolean[]> {
  const projectStartMs = Date.parse(project.metadata.project_start);
  if (!Number.isFinite(projectStartMs)) throw new Error("Invalid project start date-time.");
  const shiftsByCalendar = new Map<string, SchedulingProject["calendar_shifts"]>();

  for (const shift of project.calendar_shifts) {
    if (!shift.enabled) continue;
    const shifts = shiftsByCalendar.get(shift.calendar_id) ?? [];
    shifts.push(shift);
    shiftsByCalendar.set(shift.calendar_id, shifts);
  }

  const output: Record<string, boolean[]> = {};
  for (const calendar of project.calendars) {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: calendar.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const intervals: Array<[number, number]> = [];
    const shifts = shiftsByCalendar.get(calendar.calendar_id) ?? [];
    const firstParts = localParts(formatter, projectStartMs);
    const lastParts = localParts(formatter, projectStartMs + horizonH * HOUR_MS);
    const localFirstDate = Date.UTC(firstParts[0], firstParts[1] - 1, firstParts[2]) - DAY_MS;
    const localLastDate = Date.UTC(lastParts[0], lastParts[1] - 1, lastParts[2]) + DAY_MS;

    for (let localDateMs = localFirstDate; localDateMs <= localLastDate; localDateMs += DAY_MS) {
      const localDate = new Date(localDateMs);
      const key = dateKey(localDateMs);
      if (calendar.valid_from && key < calendar.valid_from) continue;
      if (calendar.valid_to && key > calendar.valid_to) continue;

      for (const shift of shifts) {
        if (WEEKDAY[shift.weekday] !== localDate.getUTCDay()) continue;
        const startMinutes = parseClock(shift.start_time);
        let endMinutes = parseClock(shift.end_time);
        if (endMinutes <= startMinutes) endMinutes += 24 * 60;
        intervals.push([
          localBoundary(formatter, localDateMs + startMinutes * 60_000, false),
          localBoundary(formatter, localDateMs + endMinutes * 60_000, true),
        ]);
      }
    }

    output[calendar.calendar_id] = Array.from({ length: horizonH }, (_, slot) => {
      const start = projectStartMs + slot * HOUR_MS;
      const end = start + HOUR_MS;
      return intervals.some(([intervalStart, intervalEnd]) => start >= intervalStart && end <= intervalEnd);
    });
  }

  return output;
}

export function segmentsFromSlots(slots: number[]): Array<[number, number]> {
  if (slots.length === 0) return [];
  const ordered = [...slots].sort((left, right) => left - right);
  const segments: Array<[number, number]> = [];
  let start = ordered[0];
  let previous = ordered[0];
  for (const slot of ordered.slice(1)) {
    if (slot !== previous + 1) {
      segments.push([start, previous + 1]);
      start = slot;
    }
    previous = slot;
  }
  segments.push([start, previous + 1]);
  return segments;
}
