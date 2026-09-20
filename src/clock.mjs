const TIME_ZONE = 'America/New_York';
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25'
]);

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

let source = () => new Date();

function parts(date) {
  return Object.fromEntries(formatter.formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
}

function local(date) {
  const value = parts(date);
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    weekday: value.weekday,
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second)
  };
}

function marketDay(value) {
  return !['Sat', 'Sun'].includes(value.weekday) && !HOLIDAYS.has(value.date);
}

function minuteOfDay(value) {
  return value.hour * 60 + value.minute;
}

function minuteStart(date) {
  const value = new Date(date);
  value.setUTCSeconds(0, 0);
  return value;
}

function findNext(now, hour, minute, predicate, allowCurrentMinute = false) {
  const start = minuteStart(now);
  const current = local(now);
  if (allowCurrentMinute && current.hour === hour && current.minute === minute && predicate(current)) return start;
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    const value = local(candidate);
    if (value.hour === hour && value.minute === minute && predicate(value) && candidate > now) return candidate;
  }
  throw new Error('No matching market time found within eight days');
}

export function setNow(next) {
  source = typeof next === 'function' ? next : () => new Date(next);
}

export function resetNow() {
  source = () => new Date();
}

export function now() {
  return new Date(source());
}

export function state(input = now()) {
  const current = new Date(input);
  const value = local(current);
  const minute = minuteOfDay(value);
  const tradingDay = marketDay(value);
  let window = 'dark';
  if (tradingDay && minute >= 240 && minute < 570) window = 'pre_bell';
  if (tradingDay && minute >= 570 && minute < 1200) window = 'broker_open';
  const nextBell = findNext(current, 9, 30, marketDay);
  const nextUnwind = findNext(current, 9, 29, marketDay, true);
  const nextDarkStart = findNext(current, 20, 0, marketDay);
  return {
    now: current.toISOString(),
    et: `${value.date} ${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}:${String(value.second).padStart(2, '0')} ET`,
    window,
    tradingDay,
    nextBell: nextBell.toISOString(),
    nextUnwind: nextUnwind.toISOString(),
    nextDarkStart: nextDarkStart.toISOString(),
    msToUnwind: nextUnwind.getTime() - current.getTime()
  };
}

export function isDark(input = now()) {
  return state(input).window === 'dark';
}

export { HOLIDAYS, TIME_ZONE };
