import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { remoteScreen } from "../browser/remote-screen.ts";
import { type LoginState, sGroup } from "../browser/s-group/index.ts";
import { ok, okContent, run, type ToolContentBlock } from "./tool-result.ts";

// Turns raw login state into the instructions an agent needs to drive the
// next step — what to ask the human for, and which tool to call next.
function describeState(state: LoginState): ToolContentBlock[] {
	const blocks: ToolContentBlock[] = [];
	switch (state.phase) {
		case "awaiting_captcha":
			blocks.push({
				type: "text",
				text:
					"A captcha challenge appeared. Show the attached image to the human user, ask them " +
					"to read the text in it, then call s_etukortti_login_captcha with their answer.",
			});
			if (state.captchaImageBase64) {
				blocks.push({ type: "image", data: state.captchaImageBase64, mimeType: "image/png" });
			}
			break;
		case "awaiting_otp":
			blocks.push({
				type: "text",
				text:
					"A one-time code was emailed to the user. Ask the user to check their inbox and give " +
					"you the code, then call s_etukortti_login_otp with it. Never read the email yourself.",
			});
			break;
		case "awaiting_strong_auth": {
			const methods = state.strongAuthMethods?.length
				? state.strongAuthMethods.join(", ")
				: "(no methods detected)";
			blocks.push({
				type: "text",
				text:
					"The service now requires strong authentication (pankkitunnukset). Ask the human user " +
					`which method they want. Available methods: ${methods}. Bank credentials and PINs must ` +
					"NEVER pass through this chat — Mobiilivarmenne is recommended, since only a phone " +
					"number is relayed here and the actual approval happens on the user's own phone. Call " +
					"s_etukortti_login_strong_auth with the chosen method name, then (for Mobiilivarmenne) " +
					"s_etukortti_login_strong_auth_phone with the phone number, then " +
					"s_etukortti_login_strong_auth_wait to finish once the user approves. For bank " +
					"login (or if the user has no Mobiilivarmenne), call s_etukortti_login_remote_screen " +
					"instead: the user picks the method and types bank credentials themselves on a live " +
					"view of the login page.",
			});
			if (state.pageInfo) {
				blocks.push({ type: "text", text: `Current page:\n${state.pageInfo}` });
			}
			break;
		}
		case "logged_in":
			blocks.push({
				type: "text",
				text:
					"Login succeeded. The session is stored in the persistent browser profile — receipt " +
					"tools should now work.",
			});
			break;
		case "failed":
			blocks.push({ type: "text", text: `Login failed: ${state.error ?? "unknown error"}` });
			break;
		case "idle":
			if (state.starting) {
				blocks.push({
					type: "text",
					text:
						"A login is already starting (opening the login page or submitting the email). " +
						"Do not restart it: that would email a second code. Wait a few seconds, then call " +
						"s_etukortti_login_start again with the same email (no restart) to see its next step.",
				});
				break;
			}
			blocks.push({ type: "text", text: state.error ?? "No login is in progress." });
			break;
	}
	// The captcha image and page snapshot already went out as their own blocks
	// above when present — repeating them inside the JSON text would just
	// bloat the response.
	const { captchaImageBase64, pageInfo, ...rest } = state;
	blocks.push({ type: "text", text: JSON.stringify(rest, null, 2) });
	return blocks;
}

export function registerLoginTools(server: McpServer): void {
	server.registerTool(
		"s_etukortti_login_start",
		{
			description:
				"Start the S-ryhmä email one-time-code login for s-etukortti.fi. Ask the human user " +
				"for their email address first — never guess it or read it from anywhere else. The " +
				"result may show a captcha image to relay to the user (then call " +
				"s_etukortti_login_captcha), or say a one-time code was emailed (then call " +
				"s_etukortti_login_otp). Never read the user's email inbox programmatically. If a " +
				"login is already in progress (e.g. an automatic re-login already emailed a code), " +
				"this returns that login's current step instead of starting over; pass restart: true " +
				"only when the human wants a fresh attempt.",
			inputSchema: z.object({
				email: z.string().email().describe("Email address the user gave you for S-tunnus login"),
				restart: z
					.boolean()
					.optional()
					.describe("Discard a login already in progress and start a new one"),
			}),
		},
		async ({ email, restart }) =>
			run("Error starting S-Etukortti login", async () => {
				const state = await sGroup.login.start(email, { restart });
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_captcha",
		{
			description:
				"Submit the text the human user read from the S-Etukortti login captcha image shown " +
				"by s_etukortti_login_start. The result may show a new captcha image (wrong answer — " +
				"ask the user again) or move on to the one-time code step.",
			inputSchema: z.object({
				text: z.string().min(1).describe("Text the user read from the captcha image"),
			}),
		},
		async ({ text }) =>
			run("Error submitting S-Etukortti captcha", async () => {
				const state = await sGroup.login.submitCaptcha(text);
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_otp",
		{
			description:
				"Submit the one-time code the human user received by email during S-Etukortti login. " +
				"On success the session is stored in the persistent browser profile and receipt tools " +
				"work; on a rejected code you may be asked to retry once with a corrected code. The " +
				"service may instead require strong authentication next (a list of bank/Mobiilivarmenne " +
				"methods) — if so, call s_etukortti_login_strong_auth.",
			inputSchema: z.object({
				code: z.string().min(1).describe("One-time code from the user's email"),
			}),
		},
		async ({ code }) =>
			run("Error submitting S-Etukortti one-time code", async () => {
				const state = await sGroup.login.submitOtp(code);
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_strong_auth",
		{
			description:
				"Choose a strong-authentication (pankkitunnukset) method after the S-Etukortti email " +
				"one-time code. Ask the human user which method they want from the list shown in the " +
				"login state (strongAuthMethods). Bank credentials and PINs must NEVER be typed into or " +
				"relayed through this chat — Mobiilivarmenne is recommended, because only the user's " +
				"phone number is relayed here (via s_etukortti_login_strong_auth_phone) and the actual " +
				"approval happens on the user's own phone. Returns a snapshot of the provider's page " +
				"(pageInfo) so you can tell the user what to do next, since its layout is not known ahead " +
				"of time.",
			inputSchema: z.object({
				method: z
					.string()
					.min(1)
					.describe(
						"Exact method name from strongAuthMethods, e.g. 'Mobiilivarmenne', 'S-Pankki', 'Nordea'",
					),
			}),
		},
		async ({ method }) =>
			run("Error selecting S-Etukortti strong-authentication method", async () => {
				const state = await sGroup.login.chooseStrongAuthMethod(method);
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_strong_auth_phone",
		{
			description:
				"For the Mobiilivarmenne strong-authentication method: submit the human user's phone " +
				"number so the provider can send an approval request to their phone. Ask the user for " +
				"their phone number first. The result's pageInfo may then show a short verification code " +
				"— tell the user to check that it matches the code shown on their own phone before they " +
				"approve the request there.",
			inputSchema: z.object({
				phoneNumber: z.string().min(5).describe("The user's phone number for Mobiilivarmenne"),
			}),
		},
		async ({ phoneNumber }) =>
			run("Error submitting S-Etukortti strong-authentication phone number", async () => {
				const state = await sGroup.login.fillStrongAuthPhone(phoneNumber);
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_strong_auth_wait",
		{
			description:
				"Wait for the human user to approve the strong-authentication request on their own " +
				"device (phone app or bank site). Call this after s_etukortti_login_strong_auth (and, " +
				"for Mobiilivarmenne, after s_etukortti_login_strong_auth_phone). On success the session " +
				"is stored and receipt tools work. If it times out the login stays pending — just call " +
				"this tool again once the user says they've approved.",
			inputSchema: z.object({
				timeoutSeconds: z
					.number()
					.int()
					.min(30)
					.max(300)
					.optional()
					.describe("How long to wait for approval, in seconds (default 180, max 300)"),
			}),
		},
		async ({ timeoutSeconds }) =>
			run("Error waiting for S-Etukortti strong-authentication completion", async () => {
				const state = await sGroup.login.waitForStrongAuthCompletion(timeoutSeconds);
				return okContent(describeState(state));
			}),
	);

	server.registerTool(
		"s_etukortti_login_remote_screen",
		{
			description:
				"Open a live, interactive view of the login browser for strong authentication by bank " +
				"credentials (or any method the human wants to do by hand). Only works while the login " +
				"is in awaiting_strong_auth. Returns a URL reachable ONLY from the user's own Tailscale " +
				"devices (e.g. their phone with the Tailscale app on). Give the URL to the user: they " +
				"choose the method and log in themselves on that screen — NEVER ask for bank " +
				"credentials in chat. While they do that, call s_etukortti_login_strong_auth_wait " +
				"repeatedly until the phase is logged_in. The screen closes automatically when the " +
				"login leaves awaiting_strong_auth or after its time limit (default 15 min).",
			inputSchema: z.object({}),
		},
		async () => run("Error opening remote login screen", async () => ok(await remoteScreen.open())),
	);

	server.registerTool(
		"s_etukortti_login_remote_screen_close",
		{
			description:
				"Close the remote login screen early (it also closes by itself on login or timeout).",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error closing remote login screen", async () => {
				remoteScreen.close("manual");
				return ok(remoteScreen.status());
			}),
	);

	server.registerTool(
		"s_etukortti_login_cancel",
		{
			description:
				"Cancel an in-progress S-Etukortti login attempt and close its browser page. Use this " +
				"if the human user wants to stop or start over.",
			inputSchema: z.object({}),
		},
		async () =>
			run("Error cancelling S-Etukortti login", async () => {
				const state = await sGroup.login.cancel();
				return ok(state);
			}),
	);
}
