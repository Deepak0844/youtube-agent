// Display helpers. Pure: no IO.
const IST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** "07 Nov 2026, 14:30 IST" for a Date or an ISO string. Empty string for an unparseable value. */
export function formatIst(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return `${IST.format(d).replace(" at ", ", ")} IST`;
}
