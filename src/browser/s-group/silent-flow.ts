// Silent logins to other S-group services through the shared IdP (today
// S-ostoslista). They ride the same S-tunnus SSO session as the S-Etukortti
// relogin, so they obey the same gate and take the IdP lease exclusively: a
// flow that reaches a recognised human step sets the relogin block, and the
// block declines every automatic flow until a human login through the IdP
// completes. So each SSO expiry costs at most one automatically triggered
// one-time-code email, plus the one the human's own login mails: a stopped
// flow closes its page instead of handing it over (the human logs in to
// S-Etukortti, not here), so when S-ostoslista notices the expiry first, two
// codes go out in total.
import { logger } from "../../logger.ts";
import { SessionExpiredError } from "./errors.ts";
import { decideRelogin, type ReloginDecision } from "./gate.ts";
import type { IdpLease, LeaseHolder } from "./lease.ts";
import type {
	CallbackFlowObservation,
	CallbackFlowTarget,
	Clock,
	IdpDriver,
	SessionStore,
} from "./ports.ts";

export type SilentIdpFlowName = Extract<LeaseHolder, "ostoslista">;

type Decline = Extract<ReloginDecision, { kind: "decline" }>;

export type SilentIdpFlowOutcome =
	| { kind: "callback"; url: string }
	// Never cooling_down or still_unauthorized in practice: these flows run on
	// a human's request, and both holds belong to the S-Etukortti relogin's
	// own attempts.
	| { kind: "declined"; reason: Decline["reason"]; detail: string }
	| { kind: "needs_human"; detail: string }
	| Extract<CallbackFlowObservation, { kind: "failed" }>;

export type SilentIdpFlowDeps = {
	idp: IdpDriver;
	store: SessionStore;
	clock: Clock;
	lease: IdpLease;
	humanLoginActive(): Promise<boolean>;
};

const SERVICE_NAMES: Record<SilentIdpFlowName, string> = { ostoslista: "S-ostoslista" };

export function createSilentIdpFlows(
	deps: SilentIdpFlowDeps,
): (flow: SilentIdpFlowName, target: CallbackFlowTarget) => Promise<SilentIdpFlowOutcome> {
	const { idp, store, clock, lease } = deps;

	async function gate(
		flow: SilentIdpFlowName,
	): Promise<
		{ kind: "attempt"; email: string } | Extract<SilentIdpFlowOutcome, { kind: "declined" }>
	> {
		const decision = decideRelogin(
			{
				blockedReason: store.getReloginBlock(),
				lastAttempt: null,
				loginCompletedSinceAttempt: false,
				lastReloginSucceededAt: null,
				appSessionRefused: false,
				savedEmail: store.getSavedEmail(),
				humanLoginActive: await deps.humanLoginActive(),
			},
			clock.now(),
		);
		if (decision.kind === "attempt") return decision;
		logger.info(
			{ flow, reason: decision.reason, detail: decision.detail },
			"Silent IdP flow declined",
		);
		return { kind: "declined", reason: decision.reason, detail: decision.detail };
	}

	function stopAtHumanStep(
		flow: SilentIdpFlowName,
		step: Extract<CallbackFlowObservation, { kind: "human_step" }>,
	): SilentIdpFlowOutcome {
		const service = SERVICE_NAMES[flow];
		const reason =
			`Automatic ${service} login stopped at a human step (${step.step} on ${step.where}): ` +
			"OTP, captcha and strong authentication are never automated. A human must finish the " +
			"S-Etukortti login via the s_etukortti_login_* tools (or `bun run login` with the " +
			`server stopped); that revives the S-tunnus SSO session, after which the ${service} ` +
			"login completes silently.";
		store.setReloginBlock(reason);
		const ages = store.loginAges();
		// Same lifetime fields as the relogin handover: the SSO died somewhere
		// after the last S-Etukortti login that touched the IdP.
		logger.warn(
			{
				flow,
				step: step.step,
				where: step.where,
				ssoExpired: true,
				hoursSinceHumanLogin: ages?.hoursSinceHumanLogin ?? null,
				hoursSinceSilentLogin: ages?.hoursSinceSilentLogin ?? null,
			},
			"Silent IdP flow needs a human step: page closed, relogin blocked until a login completes",
		);
		return { kind: "needs_human", detail: reason };
	}

	return async function runSilentIdpFlow(flow, target) {
		const first = await gate(flow);
		if (first.kind === "declined") return first;

		let release: () => void;
		try {
			release = await lease.acquireExclusive(flow);
		} catch (err) {
			// A human login holds the IdP, or a silent one outlasted the wait.
			if (err instanceof SessionExpiredError) {
				logger.info(
					{ flow, reason: err.reason },
					"Silent IdP flow declined: IdP lease not granted",
				);
				return { kind: "declined", reason: "login_in_progress", detail: err.message };
			}
			throw err;
		}

		try {
			// The flow we queued behind may have just stopped at a human step and
			// set the block; driving the IdP now would mail a second code.
			const decision = await gate(flow);
			if (decision.kind === "declined") return decision;

			logger.info({ flow, email: decision.email }, "Silent IdP flow started");
			const observation = await idp.runCallbackFlow(target, decision.email);
			switch (observation.kind) {
				case "callback": {
					// Not recorded in the login history, whose lifetime fields are
					// S-Etukortti's own; the block cannot be set here (the gate ran
					// under the lease), so there is nothing to clear either.
					const ages = store.loginAges();
					logger.info(
						{
							flow,
							hoursSinceHumanLogin: ages?.hoursSinceHumanLogin ?? null,
							hoursSinceSilentLogin: ages?.hoursSinceSilentLogin ?? null,
						},
						"Silent IdP flow reached its callback (S-tunnus SSO session alive)",
					);
					return observation;
				}
				case "human_step":
					if (observation.step === "unknown") {
						// Not a recognised human step, so no evidence the SSO is dead:
						// blocking here would stop the hourly relogins over a page hiccup.
						logger.warn(
							{ flow, where: observation.where },
							"Silent IdP flow stuck on an unrecognised IdP screen",
						);
						return {
							kind: "failed",
							reason: "unexpected_idp_page",
							detail: `Stuck on ${observation.where} without a recognised login step.`,
						};
					}
					return stopAtHumanStep(flow, observation);
				case "failed":
					logger.warn(
						{ flow, reason: observation.reason, detail: observation.detail },
						"Silent IdP flow failed",
					);
					return observation;
			}
		} catch (err) {
			logger.warn({ err, flow }, "Silent IdP flow threw");
			throw err;
		} finally {
			// Never handed to a human login: the human logs in to S-Etukortti,
			// which revives the SSO session this flow needs.
			const closing = idp.close();
			release();
			await closing;
		}
	};
}
