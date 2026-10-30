import { logger } from "../logger.ts";

// Shared MCP tool-result shape. Text-only originally; the login tools also
// need to hand back captcha screenshots, so the content union covers images.
export type ToolContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export type ToolResult = {
	content: ToolContentBlock[];
	isError?: boolean;
};

export function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function okContent(content: ToolContentBlock[]): ToolResult {
	return { content };
}

export function fail(context: string, error: unknown): ToolResult {
	logger.error({ err: error }, context);
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: `${context}: ${message}` }], isError: true };
}

export async function run(context: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await fn();
	} catch (error) {
		return fail(context, error);
	}
}
