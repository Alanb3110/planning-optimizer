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

function parseOffsetMinutes(value: string): number {
  if (value.endsWith("Z")) return 0;
  const match = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Date-time '${value}' must include a UTC offset.`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

function parseClock(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid shift time '${value}'.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function dateKey(dateMs: number): string {
  return new Date(dateMs).toISOString().slice(0, 10);
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
  const projectOffsetMinutes = parseOffsetMinutes(project.metadata.project_start);
  const localProjectStartMs = projectStartMs + projectOffsetMinutes * 60_000;
  const shiftsByCalendar = new Map<string, SchedulingProject["calendar_shifts"]>();

  for (const shift of project.calendar_shifts) {
    if (!shift.enabled) continue;
    const shifts = shiftsByCalendar.get(shift.calendar_id) ?? [];
    shifts.push(shift);
    shiftsByCalendar.set(shift.calendar_id, shifts);
  }

  const output: Record<string, boolean[]> = {};
  const localFirstDate = Date.UTC(
    new Date(localProjectStartMs).getUTCFullYear(),
    new Date(localProjectStartMs).getUTCMonth(),
    new Date(localProjectStartMs).getUTCDate(),
  ) - DAY_MS;
  const localLastDate = localFirstDate + (Math.ceil(horizonH / 24) + 3) * DAY_MS;

  for (const calendar of project.calendars) {
    const intervals: Array<[number, number]> = [];
    const shifts = shiftsByCalendar.get(calendar.calendar_id) ?? [];

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
        const offsetMs = projectOffsetMinutes * 60_000;
        intervals.push([
          localDateMs + startMinutes * 60_000 - offsetMs,
          localDateMs + endMinutes * 60_000 - offsetMs,
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
