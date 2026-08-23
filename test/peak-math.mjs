import { zonedClock, isPeak, nextOffpeakAt } from "file:///D:/project/ai/dsh-plugins-package/dsh-offpeak-gate/lib/index.js";

const cfg = { timeZone: "Asia/Shanghai", peakWindows: [[9, 12], [14, 18]], weekendsOffpeak: true };

const now = new Date();
const clock = zonedClock(cfg.timeZone, now);
console.log("now(zoned)=", JSON.stringify(clock));
console.log("isPeak=", isPeak(clock, cfg));
const next = nextOffpeakAt(cfg, now);
console.log("nextOffpeakAt=", next.toISOString(), "-> local", new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(next));

const cases = [
  ["2026-08-21T01:00:00Z", "周五 09:00"],
  ["2026-08-21T03:59:00Z", "周五 11:59"],
  ["2026-08-21T04:00:00Z", "周五 12:00"],
  ["2026-08-21T07:00:00Z", "周五 15:00"],
  ["2026-08-21T09:00:00Z", "周五 17:00"],
  ["2026-08-21T10:00:00Z", "周五 18:00"],
  ["2026-08-21T23:00:00Z", "周五 07:00 次日"],
  ["2026-08-22T02:00:00Z", "周六 10:00"],
  ["2026-08-24T03:00:00Z", "周一 11:00"],
];
let fail = 0;
for (const [iso, label] of cases) {
  const d = new Date(iso);
  const c = zonedClock(cfg.timeZone, d);
  const p = isPeak(c, cfg);
  const extra = p ? "next=" + nextOffpeakAt(cfg, d).toISOString() : "";
  console.log(label, "->", c.dow, c.minutes, "peak=", p, extra);
}
process.exit(fail);
