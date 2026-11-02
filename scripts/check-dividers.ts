// Fails on section-divider comments (`// --- Name ---`, `// ====`), which
// CLAUDE.md rules out. Biome cannot catch them: its GritQL plugins see no
// comments, since they are trivia rather than syntax nodes.
//
// Usage: bun run scripts/check-dividers.ts [files...]  (default: every tracked TS file)

// A divider opens with a run of rule characters: `// ====` or `// --- Name ---`.
// Prose that merely ends in one (`// TODO ---`, a URL ending in `___`) is left alone.
const DIVIDER = /^\s*\/\/\s*[-=*#~_]{3,}/;

const say = (msg: string) => process.stderr.write(`${msg}\n`);

function trackedFiles(): string[] {
	// -z: names with spaces or non-ASCII characters come out unquoted.
	const out = Bun.spawnSync(["git", "ls-files", "-z", "*.ts"]);
	if (out.exitCode !== 0) throw new Error("git ls-files failed");
	return out.stdout.toString().split("\0").filter(Boolean);
}

export function findDividers(text: string): number[] {
	return text.split("\n").flatMap((line, i) => (DIVIDER.test(line) ? [i + 1] : []));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const files = (args.length > 0 ? args : trackedFiles()).filter((f) => f.endsWith(".ts"));
	let found = 0;
	for (const file of files) {
		// A tracked file deleted but not yet `git rm`'d has nothing to check.
		if (!(await Bun.file(file).exists())) continue;
		for (const line of findDividers(await Bun.file(file).text())) {
			say(`${file}:${line}: section divider comment; drop it (CLAUDE.md: comments explain why)`);
			found++;
		}
	}
	if (found > 0) process.exit(1);
}

if (import.meta.main) await main();
