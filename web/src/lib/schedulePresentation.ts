import type { ScheduledActivity, SchedulingProject } from "./scheduler/types";

const HOUR_MS = 3_600_000;

export function resultTimezone(project: SchedulingProject): string {
  return project.calendars.find((calendar) => calendar.calendar_id === project.metadata.active_calendar)?.timezone
    ?? project.calendars[0]?.timezone ?? "UTC";
}

export function sortedActivities(project: SchedulingProject, activities: ScheduledActivity[]): ScheduledActivity[] {
  const byId = new Map(project.activities.map((item) => [item.activity_id, item]));
  const packages = new Map(project.packages.map((item) => [item.package_id, item]));
  return [...activities].sort((left, right) => {
    const leftPackage = byId.get(left.activityId)!.package_id;
    const rightPackage = byId.get(right.activityId)!.package_id;
    const leftOrder = typeof packages.get(leftPackage)?.display_order === "number" ? packages.get(leftPackage)!.display_order as number : Infinity;
    const rightOrder = typeof packages.get(rightPackage)?.display_order === "number" ? packages.get(rightPackage)!.display_order as number : Infinity;
    return packages.get(leftPackage)!.system_id.localeCompare(packages.get(rightPackage)!.system_id)
      || (leftOrder - rightOrder) || leftPackage.localeCompare(rightPackage)
      || left.startH - right.startH
      || left.activityId.localeCompare(right.activityId);
  });
}

function parts(date: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

export function localIso(instant: string | Date, timezone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const p = parts(date, timezone);
  const wallMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const minutes = Math.round((wallMs - date.getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const milliseconds = date.getUTCMilliseconds();
  const fraction = milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : "";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${fraction}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export interface CalendarTick { offsetH: number; dateLabel: string; offsetLabel: string }

export function calendarTicks(projectStart: string, endH: number, timezone: string): CalendarTick[] {
  const origin = Date.parse(projectStart);
  const stride = endH <= 168 ? 1 : endH <= 24 * 90 ? 7 : endH <= 24 * 365 ? 14 : 30;
  const dayFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, day: "2-digit", month: "2-digit", year: "numeric",
  });
  const dayKey = (ms: number) => dayFormatter.format(ms);
  const labelFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, day: "2-digit", month: "short", year: "numeric",
  });
  const label = (ms: number) => labelFormatter.format(ms);
  const ticks: CalendarTick[] = [{ offsetH: 0, dateLabel: label(origin), offsetLabel: "H+0" }];
  let previousDay = dayKey(origin);
  let dayIndex = 0;
  for (let hour = 1; hour <= Math.ceil(endH); hour++) {
    const current = origin + hour * HOUR_MS;
    const day = dayKey(current);
    if (day === previousDay) continue;
    dayIndex++;
    if (dayIndex % stride === 0) {
      // Locate the actual local midnight: DST and fractional UTC offsets move it
      // away from a fixed H+ multiple.
      let lower = current - HOUR_MS;
      let upper = current;
      while (upper - lower > 1) {
        const middle = Math.floor((upper + lower) / 2);
        if (dayKey(middle) === day) upper = middle;
        else lower = middle;
      }
      const midnight = Math.round(upper / 60_000) * 60_000;
      const offsetH = (midnight - origin) / HOUR_MS;
      if (offsetH <= endH) ticks.push({
        offsetH, dateLabel: label(midnight), offsetLabel: `H+${Number(offsetH.toFixed(2))}`,
      });
    }
    previousDay = day;
  }
  return ticks;
}
