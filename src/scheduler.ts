import { generateMorningReview } from "./review";

type Deliver = (content: string) => Promise<void>;

function runDailyAt(
  label: string,
  timeHHMM: string,
  timezone: string,
  run: () => Promise<void>
): void {
  const [targetHour, targetMinute] = timeHHMM.split(":").map(Number);
  let lastRunDate = "";

  setInterval(() => {
    const now = new Date();
    const localParts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const currentHour = parseInt(
      localParts.find((p) => p.type === "hour")!.value,
      10
    );
    const currentMinute = parseInt(
      localParts.find((p) => p.type === "minute")!.value,
      10
    );
    const today = now.toLocaleDateString("en-CA", { timeZone: timezone });

    if (
      currentHour === targetHour &&
      currentMinute === targetMinute &&
      lastRunDate !== today
    ) {
      lastRunDate = today;
      console.log(`[${label}] running at ${timeHHMM} (${timezone})...`);
      run().catch((err) => console.error(`[${label}] error:`, err));
    }
  }, 60_000);

  console.log(`[${label}] scheduled at ${timeHHMM} (${timezone})`);
}

export function startScheduler(): void {
  const reviewTime = process.env.MORNING_REVIEW_TIME || "06:00";
  const timezone = process.env.TIMEZONE || "UTC";
  runDailyAt("personal-review", reviewTime, timezone, async () => {
    await generateMorningReview();
  });
}

export function startFamilyScheduler(deliver: Deliver): void {
  const reviewTime = process.env.FAMILY_MORNING_REVIEW_TIME || "06:30";
  const timezone =
    process.env.FAMILY_TIMEZONE || "Asia/Hong_Kong";
  runDailyAt("family-review", reviewTime, timezone, async () => {
    await generateMorningReview({
      scope: "family",
      queryScopes: ["family"],
      deliver,
    });
  });
}
