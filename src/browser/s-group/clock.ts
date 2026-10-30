import { logger } from "../../logger.ts";
import type { Cancel, Clock } from "./ports.ts";

function guarded(fn: () => Promise<void> | void): () => void {
	return () => {
		Promise.resolve()
			.then(fn)
			.catch((err) => {
				// Callbacks record their own failures; this only catches a truly
				// unexpected throw so it can't become an unhandled rejection.
				logger.error({ err }, "S-group timer callback failed unexpectedly");
			});
	};
}

// Timers are unref'd so a pending keepalive never keeps `bun run login` or a
// test process alive.
export const systemClock: Clock = {
	now: () => Date.now(),
	every(ms, fn): Cancel {
		const timer = setInterval(guarded(fn), ms);
		timer.unref?.();
		return () => clearInterval(timer);
	},
	after(ms, fn): Cancel {
		const timer = setTimeout(guarded(fn), ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};
