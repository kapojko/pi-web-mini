/**
 * pi-web-mini — minimal web access for the pi coding agent.
 *
 * Two tools, two commands, zero runtime dependencies:
 *
 *   web_search  — Exa /search. Title + URL + date + a short highlight per
 *                 result (default 5). Lean on purpose: the model calls
 *                 web_fetch only for pages it actually needs.
 *   web_fetch   — dual mode, switched at call time (no /reload needed):
 *                 builtin — node fetch + regex HTML→plain text (script/style/
 *                           comments stripped, block tags → newlines, entities
 *                           decoded). Links lost, fattest savings for small
 *                           context windows.
 *                 exa     — Exa /contents → Exa-cleaned text (headings and
 *                           code kept; inline links not guaranteed),
 *                           livecrawl fallback. Needs an API key.
 *
 *   /webauth <key>  — store the Exa API key in ~/.pi/agent/web-mini.json;
 *                     EXA_API_KEY env var is the fallback.
 *   /webmode [builtin|exa] — show or switch the web_fetch mode.
 *
 * Guards shared by both fetch paths: http/https only, DNS-based SSRF block
 * of private/loopback/link-local targets, 30 s total timeout, ~2 MiB body
 * cap, textual content-types only, model-facing text capped at MAX_TEXT
 * chars with a truncation marker. Known limitation: redirect following is
 * delegated to fetch, so a public URL that redirects to a private host is
 * not re-checked.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lookup } from "node:dns/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Tunables ────────────────────────────────────────────────────────────
const CONFIG_PATH = join(homedir(), ".pi", "agent", "web-mini.json");
const EXA_API = "https://api.exa.ai";
const EXA_KEY_ENV = "EXA_API_KEY";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // network body cap
const MAX_TEXT = 20_000; // model-facing text cap
const SEARCH_SNIPPET_SENTENCES = 2;
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ── Config ──────────────────────────────────────────────────────────────
interface WebMiniConfig {
	exaApiKey?: string;
	fetchMode?: "builtin" | "exa";
}

export async function readConfig(): Promise<WebMiniConfig> {
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as WebMiniConfig;
	} catch {
		return {};
	}
}

export async function writeConfig(patch: Partial<WebMiniConfig>): Promise<void> {
	const merged = { ...(await readConfig()), ...patch };
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(merged, null, "\t") + "\n", "utf8");
}

export function resolveApiKey(config: WebMiniConfig): { key?: string; source: "file" | "env" } {
	if (config.exaApiKey) return { key: config.exaApiKey, source: "file" };
	if (process.env[EXA_KEY_ENV]) return { key: process.env[EXA_KEY_ENV], source: "env" };
	return { source: "env" };
}

function maskKey(key: string): string {
	return key.length <= 8 ? "…" : `…${key.slice(-4)}`;
}

// ── Guards ──────────────────────────────────────────────────────────────
function addSubnets(list: BlockList, subnets: string[]): void {
	for (const subnet of subnets) {
		const [base, prefix] = subnet.split("/")!;
		list.addSubnet(base!, Number(prefix), isIP(base!) === 6 ? "ipv6" : "ipv4");
	}
}

const PRIVATE_V4 = new BlockList();
addSubnets(PRIVATE_V4, [
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
	"198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
]);
const PRIVATE_V6 = new BlockList();
addSubnets(PRIVATE_V6, ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"]);

function isPrivateAddress(ip: string): boolean {
	if (isIP(ip) === 4) return PRIVATE_V4.check(ip, "ipv4");
	if (isIP(ip) === 6) return PRIVATE_V6.check(ip, "ipv6");
	return true; // not an IP → treat as private (defensive)
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Unsupported protocol: ${url.protocol} (http/https only)`);
	}
	if (isIP(url.hostname)) {
		if (isPrivateAddress(url.hostname)) throw new Error(`Refusing private address: ${url.hostname}`);
		return url;
	}
	let records;
	try {
		records = await lookup(url.hostname, { all: true, verbatim: true });
	} catch (err) {
		throw new Error(`DNS lookup failed for ${url.hostname}: ${err instanceof Error ? err.message : err}`);
	}
	if (records.length === 0 || records.some((r) => isPrivateAddress(r.address))) {
		throw new Error(`Refusing URL whose host ${url.hostname} resolves to a private/loopback address`);
	}
	return url;
}

const TEXTUAL_BASE_TYPES = new Set([
	"application/json", "application/xml", "application/javascript",
	"application/rss", "application/atom", "application/xhtml",
]);

function assertTextContentType(contentType: string | null): void {
	const base = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
	const textual = base.startsWith("text/") || base.endsWith("+xml") || base.endsWith("+json") || TEXTUAL_BASE_TYPES.has(base);
	if (!base || !textual) {
		throw new Error(`Unsupported content type: ${contentType || "(none)"} — web_fetch delivers text content only`);
	}
}

// ── HTML → plain text ───────────────────────────────────────────────────
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", hellip: "…",
	mdash: "—", ndash: "–", middot: "·", copy: "©", reg: "®", trade: "™",
	laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};

/** Model-facing whitespace compaction: trim every line, drop whitespace-only
 *  lines (block tags were replaced by " ", leaving "\n \n" runs the blank-line
 *  collapse can't see), and collapse blank-line runs to a single blank line so
 *  paragraph separation survives. */
export function compactWhitespace(text: string): string {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/[ \t]+/g, " ").trim();
		if (line) {
			out.push(line);
		} else if (out.length && out[out.length - 1] !== "") {
			out.push("");
		}
	}
	return out.join("\n").trim();
}

function decodeEntities(text: string): string {
	return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (entity) => {
		const body = entity.slice(1, -1);
		if (body.startsWith("#")) {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
			if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return "\uFFFD";
			return String.fromCodePoint(code);
		}
		return NAMED_ENTITIES[body] ?? entity;
	});
}

export function htmlToText(html: string): string {
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		// unterminated script/style/noscript would otherwise leak as prose
		.replace(/<(?:script|style|noscript)\b[\s\S]*$/i, "")
		.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
	text = text
		.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|details|summary|dl|dd|dt|figcaption)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");
	return compactWhitespace(decodeEntities(text));
}

// ── HTTP helpers ────────────────────────────────────────────────────────
async function readBodyCapped(response: Response): Promise<string> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let body = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		body += decoder.decode(value, { stream: true });
		if (body.length > MAX_BODY_BYTES) {
			await reader.cancel();
			body += "\n…[body exceeds cap, truncated]";
			break;
		}
	}
	return body;
}

async function exaFetch(key: string, path: string, body: unknown): Promise<any> {
	let response: Response;
	try {
		response = await fetch(`${EXA_API}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": key },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : String(err);
		throw new Error(`Exa ${path} failed: ${reason}`);
	}
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		const hint = response.status === 401 || response.status === 403 ? " — check /webauth" : "";
		throw new Error(`Exa ${path} returned ${response.status}${hint}: ${detail}`);
	}
	return response.json();
}

export function capText(text: string, max = MAX_TEXT): string {
	return text.length <= max ? text : text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

// ── web_search (Exa only) ───────────────────────────────────────────────
interface ExaSearchResult {
	title?: string;
	url?: string;
	publishedDate?: string;
	highlights?: string[];
}

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: "Results to return, 1-10 (default 5)", minimum: 1, maximum: 10 })),
});

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description: "Search the web via Exa. Returns title, URL, date and a short snippet per result.",
	parameters: WebSearchParams,
	annotations: { readOnlyHint: true, openWorldHint: true },
	async execute(_toolCallId, params) {
		const { key } = resolveApiKey(await readConfig());
		if (!key) throw new Error("Exa API key is not set — run /webauth <key> or set EXA_API_KEY");

		const data = await exaFetch(key, "/search", {
			query: params.query,
			numResults: Math.min(Math.max(params.numResults ?? 5, 1), 10),
			contents: { highlights: { numSentences: SEARCH_SNIPPET_SENTENCES, highlightsPerUrl: 1 } },
		});
		const results: ExaSearchResult[] = data.results ?? [];
		if (results.length === 0) return { content: [{ type: "text", text: `No results for "${params.query}".` }], details: undefined };

		const lines = results.map((r, i) => {
			const parts = [`${i + 1}. ${r.title ?? "(untitled)"}`];
			if (r.url) parts.push(`   ${r.url}`);
			if (r.publishedDate) parts.push(`   ${r.publishedDate.slice(0, 10)}`);
			const snippet = r.highlights?.[0]?.replace(/\s+/g, " ").trim();
			if (snippet) parts.push(`   ${capText(snippet, 300)}`);
			return parts.join("\n");
		});
		return {
			content: [{ type: "text", text: lines.join("\n\n") }],
			details: { query: params.query, results: results.length },
		};
	},
});

// ── web_fetch (builtin | exa) ───────────────────────────────────────────
const WebFetchParams = Type.Object({
	url: Type.String({ description: "HTTP(S) URL to fetch" }),
});

const webFetchTool = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch one public HTTP(S) URL. Returns readable plain text (default mode) or, in Exa mode (/webmode exa), Exa-cleaned text that keeps headings and code blocks.",
	parameters: WebFetchParams,
	annotations: { readOnlyHint: true, openWorldHint: true },
	async execute(_toolCallId, params) {
		const config = await readConfig();
		const url = await assertPublicUrl(params.url);

		let text: string;
		let mode: string;
		if ((config.fetchMode ?? "builtin") === "exa") {
			const { key } = resolveApiKey(config);
			if (!key) throw new Error("Exa mode needs an API key — run /webauth <key>, set EXA_API_KEY, or /webmode builtin");
			const data = await exaFetch(key, "/contents", {
				urls: [url.href],
				text: { maxCharacters: MAX_TEXT + 2000 },
				livecrawl: "fallback",
			});
			const result = data.results?.[0];
			if (!result?.text) throw new Error(`Exa /contents returned no text for ${url.href}`);
			mode = "exa (markdown)";
			text = capText(result.text);
		} else {
			let response: Response;
			try {
				response = await fetch(url, {
					headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5" },
					redirect: "follow",
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				});
			} catch (err) {
				const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : String(err);
				throw new Error(`Fetch failed for ${url.href}: ${reason}`);
			}
			if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url.href}`);
			assertTextContentType(response.headers.get("content-type"));
			const body = await readBodyCapped(response);
			const isHtml = (response.headers.get("content-type") ?? "").includes("text/html");
			mode = "builtin (plain text)";
			text = capText(isHtml ? htmlToText(body) : body.trim());
		}

		return {
			content: [{ type: "text", text }],
			details: { url: url.href, mode, chars: text.length },
		};
	},
});

// ── Commands ────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	pi.registerCommand("webauth", {
		description: "Set (or show) the Exa API key for web-mini",
		handler: async (args, ctx) => {
			const key = args.trim();
			if (!key) {
				const config = await readConfig();
				const { key: envKey, source } = resolveApiKey(config);
				ctx.ui.notify(
					config.exaApiKey
						? `Exa API key set (${maskKey(config.exaApiKey)}, from config file)`
						: envKey
							? `No key in config; using ${EXA_KEY_ENV} env var (${maskKey(envKey!)})`
							: `No Exa API key set. Run /webauth <key> or set ${EXA_KEY_ENV}. Fetch mode: ${config.fetchMode ?? "builtin"} (${source === "file" ? "file" : "env"} source)`,
					config.exaApiKey || envKey ? "info" : "warning",
				);
				return;
			}
			await writeConfig({ exaApiKey: key });
			ctx.ui.notify(`Exa API key saved (${maskKey(key)}) → ${CONFIG_PATH}`, "info");
		},
	});

	pi.registerCommand("webmode", {
		description: "Show or switch web_fetch mode: /webmode builtin | exa",
		getArgumentCompletions: (prefix) => {
			const modes = ["builtin", "exa"];
			const filtered = modes.filter((m) => m.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (!mode) {
				const config = await readConfig();
				ctx.ui.notify(
					`web_fetch mode: ${config.fetchMode ?? "builtin"} (builtin = plain text, exa = markdown via Exa)`,
					"info",
				);
				return;
			}
			if (mode !== "builtin" && mode !== "exa") {
				ctx.ui.notify(`Unknown mode "${mode}". Usage: /webmode builtin | exa`, "error");
				return;
			}
			await writeConfig({ fetchMode: mode });
			ctx.ui.notify(`web_fetch mode set to ${mode}${mode === "exa" ? " (markdown via Exa)" : " (plain text)"}`, "info");
		},
	});

	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
}
