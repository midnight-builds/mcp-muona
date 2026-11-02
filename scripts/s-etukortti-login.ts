// Interactive one-time login to s-etukortti.fi with an email OTP code.
//
// Run with `bun run login`. Fallback CLI for the same login steps the MCP
// login tools drive (sGroup.login, src/browser/s-group/login.ts) — useful when
// there's no MCP client in the loop to relay the captcha image / OTP prompt.
// The resulting session lives in the persistent browser profile and is reused
// by the MCP tools until S-ryhmä expires it.
//
// Env:
//   LOGIN_EMAIL          skip the email prompt
//   S_ETUKORTTI_SCREEN_SIZE with DISPLAY: run with a visible browser window
//   S_ETUKORTTI_DATA_DIR override the profile directory

import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { type LoginState, sGroup } from "../src/browser/s-group/index.ts";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const say = (msg: string) => process.stdout.write(`${msg}\n`);

const SCREENSHOT_DIR = "screenshots";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function saveCaptchaImage(base64: string): Promise<string> {
	const path = `${SCREENSHOT_DIR}/captcha.png`;
	await Bun.write(path, Buffer.from(base64, "base64"));
	return path;
}

// Bank credentials are typed by the human on the provider page itself (a
// headed browser on a display); this only relays the method choice, an
// optional Mobiilivarmenne phone number, and then waits for the approval.
async function driveStrongAuth(current: LoginState): Promise<LoginState> {
	say("\nVahva tunnistautuminen vaaditaan.");
	say(`Tavat: ${current.strongAuthMethods?.join(", ") || "(ei tunnistettu)"}`);
	const method = (await rl.question("Valitse tapa (tyhjä = hoidan selaimessa itse): ")).trim();
	let state = current;
	if (method) {
		state = await sGroup.login.chooseStrongAuthMethod(method);
		if (state.phase !== "awaiting_strong_auth") return state;
		if (state.pageInfo) say(`\nSivu:\n${state.pageInfo}`);
		const phone = (await rl.question("Mobiilivarmenteen puhelinnumero (tyhjä = ohita): ")).trim();
		if (phone) {
			state = await sGroup.login.fillStrongAuthPhone(phone);
			if (state.phase !== "awaiting_strong_auth") return state;
			if (state.pageInfo) say(`\nSivu:\n${state.pageInfo}`);
		}
	}
	say("Hyväksy tunnistautuminen omalla laitteellasi. Odotetaan...");
	for (let i = 0; i < 5 && state.phase === "awaiting_strong_auth"; i++) {
		state = await sGroup.login.waitForStrongAuthCompletion();
		if (state.phase === "awaiting_strong_auth") say("Ei vielä hyväksytty, odotetaan lisää...");
	}
	return state;
}

const email =
	process.env.LOGIN_EMAIL ?? (await rl.question("Sähköpostiosoite S-tunnukselle: ")).trim();
if (!email.includes("@")) {
	say("Virheellinen sähköpostiosoite.");
	process.exit(1);
}

say("Avataan kirjautumissivu...");
let state: LoginState = await sGroup.login.start(email);

// The session module drives the browser; this loop just relays prompts to the
// human and feeds their answers back in, retrying up to a handful of rounds
// (captcha may reject an answer and re-challenge with a fresh image).
for (
	let round = 0;
	round < 10 && state.phase !== "logged_in" && state.phase !== "failed";
	round++
) {
	if (state.phase === "awaiting_captcha" && state.captchaImageBase64) {
		const path = await saveCaptchaImage(state.captchaImageBase64);
		say(`\nCaptcha-haaste! Kuva tallennettu: ${path}`);
		const answer = await rl.question("Kirjoita captcha-kuvan teksti: ");
		state = await sGroup.login.submitCaptcha(answer.trim());
		continue;
	}

	if (state.phase === "awaiting_otp") {
		say("\nKertakäyttökoodi on lähetetty sähköpostiisi.");
		if (state.error) say(state.error);
		const code = await rl.question("Syötä sähköpostiin tullut koodi: ");
		state = await sGroup.login.submitOtp(code.trim());
		continue;
	}

	if (state.phase === "awaiting_strong_auth") {
		state = await driveStrongAuth(state);
		continue;
	}

	// idle with no page (e.g. a stale-login reap) — nothing left to drive.
	say(`Odottamaton tila: ${state.phase}`);
	break;
}

if (state.phase === "logged_in") {
	say("Kirjautuminen onnistui. Istunto on tallessa selainprofiilissa.");
} else {
	say(`Kirjautuminen epäonnistui: ${state.error ?? "(tuntematon virhe)"}`);
	// Leaves nothing dangling whether the loop ended on "failed" or hit the
	// round limit while still in a human step.
	await sGroup.login.cancel();
}

await sGroup.close();
rl.close();
process.exit(state.phase === "logged_in" ? 0 : 1);
