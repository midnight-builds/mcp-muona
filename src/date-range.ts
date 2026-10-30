// Small shared date helpers for default sync ranges. Always computed against
// the Europe/Helsinki calendar regardless of the host's runtime timezone,
// since that's the timezone the S-Etukortti API and its users live in.

export interface HelsinkiDate {
	year: number;
	month: number; // 1-12
	day: number;
}

export function helsinkiToday(): HelsinkiDate {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Helsinki",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
	return { year: get("year"), month: get("month"), day: get("day") };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatHelsinkiDate({ year, month, day }: HelsinkiDate): string {
	return `${year}-${pad(month)}-${pad(day)}`;
}

// Default sync window used by both the CLI and the sync_receipts MCP tool:
// the 1st of the month two months ago, through today.
export function defaultSyncRange(): { startDate: string; endDate: string } {
	const today = helsinkiToday();
	let year = today.year;
	let month = today.month - 2;
	while (month < 1) {
		month += 12;
		year -= 1;
	}
	return {
		startDate: formatHelsinkiDate({ year, month, day: 1 }),
		endDate: formatHelsinkiDate(today),
	};
}
