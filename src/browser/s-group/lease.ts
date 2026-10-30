// The IdP lease: the in-process right to drive the shared S-tunnus SSO cookie
// jar. A second authorize request (any page that bounces to
// tunnistus.s-ryhma.fi) in the middle of a login resets the flow, so logins
// hold it exclusively and background page navigations share it.

import { logger } from "../../logger.ts";
import { SessionExpiredError } from "./errors.ts";
import type { Clock } from "./ports.ts";

export type LeaseHolder = "human_login" | "silent_relogin" | "ostoslista";

export type LeaseReport = { exclusive: LeaseHolder | null; shared: number };

// Silent flows take seconds; their own step timeouts bound them well below this.
const SILENT_WAIT_MS = 3 * 60_000;
// Page navigations time out on their own within about a minute.
const DRAIN_WAIT_MS = 90_000;

export interface IdpLease {
	// Background page navigation. Fails fast while a human login holds the
	// lease (the user's choice: never wait on a human), waits for silent flows.
	acquireShared(purpose: string): Promise<() => void>;
	// Never waits for a human login: anything but a human restart is denied.
	// Resolves with the release for this one acquisition: a caller that gave
	// up while waiting can only ever free its own grant, never a later one's.
	// abandon: checked whenever the lease changes hands; once true the wait
	// ends with login_in_progress instead of running into its timeout.
	acquireExclusive(holder: LeaseHolder, opts?: { abandon?: () => boolean }): Promise<() => void>;
	// A relogin that stopped at a human step keeps its page open for the human,
	// so the lease changes hands without ever being free in between. The grant
	// stays the same, so the original release still frees it.
	transfer(from: LeaseHolder, to: LeaseHolder): void;
	holder(): LeaseHolder | null;
	report(): LeaseReport;
}

function humanHoldsError(what: string): SessionExpiredError {
	return new SessionExpiredError(
		"login_in_progress",
		`A human login is in progress, so ${what} is not started; finish it with the ` +
			"s_etukortti_login_* tools before retrying.",
	);
}

export function createIdpLease(clock: Clock): IdpLease {
	let grant: { holder: LeaseHolder; id: number } | null = null;
	let nextGrantId = 1;
	let shared = 0;
	let pendingExclusive = 0;
	const waiters = new Set<() => void>();

	const exclusive = (): LeaseHolder | null => grant?.holder ?? null;

	function notify(): void {
		for (const waiter of [...waiters]) waiter();
	}

	// Resolves true once cond holds, false when ms runs out first.
	function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
		if (cond()) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let cancelTimer = () => {};
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				waiters.delete(check);
				cancelTimer();
				resolve(value);
			};
			const check = () => {
				if (cond()) finish(true);
			};
			waiters.add(check);
			cancelTimer = clock.after(ms, () => finish(false));
		});
	}

	return {
		async acquireShared(purpose) {
			const deadline = clock.now() + SILENT_WAIT_MS;
			let logged = false;
			for (;;) {
				if (exclusive() === "human_login") {
					logger.info({ purpose }, "IdP lease denied to a page navigation: human login holds it");
					throw humanHoldsError(`the page navigation (${purpose})`);
				}
				if (exclusive() === null && pendingExclusive === 0) break;
				if (!logged) {
					logged = true;
					logger.info(
						{ purpose, holder: exclusive() },
						"Page navigation waiting for a silent login to release the IdP lease",
					);
				}
				const free = await waitUntil(
					() => exclusive() === "human_login" || (exclusive() === null && pendingExclusive === 0),
					deadline - clock.now(),
				);
				if (!free) {
					logger.warn({ purpose, holder: exclusive() }, "IdP lease wait timed out");
					throw new SessionExpiredError(
						"login_in_progress",
						`A silent login (${exclusive() ?? "pending"}) still holds the S-tunnus login after ` +
							`${SILENT_WAIT_MS / 60_000} minutes.`,
					);
				}
			}
			shared++;
			logger.info({ purpose, shared }, "IdP lease acquired (shared)");
			let released = false;
			return () => {
				if (released) return;
				released = true;
				shared--;
				logger.info({ purpose, shared }, "IdP lease released (shared)");
				notify();
			};
		},

		async acquireExclusive(holder, opts) {
			const deadline = clock.now() + SILENT_WAIT_MS;
			const abandoned = () => opts?.abandon?.() ?? false;
			pendingExclusive++;
			try {
				for (;;) {
					if (exclusive() === "human_login" && holder !== "human_login") {
						logger.info({ holder }, "IdP lease denied: human login holds it");
						throw humanHoldsError(`a ${holder} login`);
					}
					if (exclusive() === null) break;
					if (abandoned()) {
						logger.info({ holder, current: exclusive() }, "IdP lease wait abandoned");
						throw new SessionExpiredError(
							"login_in_progress",
							`The IdP lease wait was abandoned while ${exclusive()} holds it.`,
						);
					}
					logger.info({ holder, current: exclusive() }, "Waiting for the IdP lease");
					const free = await waitUntil(
						() =>
							exclusive() === null ||
							abandoned() ||
							(holder !== "human_login" && exclusive() === "human_login"),
						deadline - clock.now(),
					);
					if (!free) {
						logger.warn({ holder, current: exclusive() }, "IdP lease wait timed out");
						throw new SessionExpiredError(
							"login_in_progress",
							`Another login (${exclusive()}) still holds the S-tunnus login after ` +
								`${SILENT_WAIT_MS / 60_000} minutes.`,
						);
					}
				}
				const id = nextGrantId++;
				grant = { holder, id };
				// New navigations already queue behind us; let the running ones finish
				// so none of them bounces to the IdP mid-login.
				const drained = await waitUntil(() => shared === 0, DRAIN_WAIT_MS);
				if (!drained) {
					logger.warn(
						{ holder, shared },
						"Page navigations still running after the drain wait; starting the login anyway",
					);
				}
				logger.info({ holder }, "IdP lease acquired (exclusive)");
				return () => {
					if (grant?.id !== id) return;
					logger.info({ holder: grant.holder }, "IdP lease released (exclusive)");
					grant = null;
					notify();
				};
			} finally {
				pendingExclusive--;
				notify();
			}
		},

		transfer(from, to) {
			if (grant?.holder !== from) return;
			grant = { holder: to, id: grant.id };
			logger.info({ from, to }, "IdP lease handed over");
			notify();
		},

		holder: exclusive,

		report: () => ({ exclusive: exclusive(), shared }),
	};
}
