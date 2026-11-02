// Fails on section-divider comments (`// --- Name ---`, `// ====`), which
// CLAUDE.md rules out. Biome cannot catch them: its GritQL plugins see no
// comments, since they are trivia rather than syntax nodes.
//
// Usage: bun run scripts/check-dividers.ts [files...]  (default: every tracked TS file)

const DIVIDER = /^\s*\/\/\s*(?:[-=*#~_]{3,}|.*[-=*#~_]{3,}\s*$)/;

const say = (msg: string) => process.stderr.write(`${msg}\n`);

function trackedFiles(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "*.ts"]);
	if (out.exitCode !== 0) throw new Error("git ls-files failed");
	return out.stdout.toString().split("\n").filter(Boolean);
}

export function findDividers(text: string): number[] {
	return text.split("\n").flatMap((line, i) => (DIVIDER.test(line) ? [i + 1] : []));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const files = (args.length > 0 ? args : trackedFiles()).filter((f) => f.endsWith(".ts"));
	let found = 0;
	for (const file of files) {
		for (const line of findDividers(await Bun.file(file).text())) {
			say(`${file}:${line}: section divider comment; drop it (CLAUDE.md: comments explain why)`);
			found++;
		}
	}
	if (found > 0) process.exit(1);
}

if (import.meta.main) await main();
