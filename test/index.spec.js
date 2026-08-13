import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";
import { copyForwardHeaders } from "../src/utils/headers.js";

describe("Hello World worker", () => {
	it("redirects HTTP -> HTTPS (unit style)", async () => {
		const request = new Request("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe('https://example.com/');
	});

	it("redirects HTTP -> HTTPS (integration style)", async () => {
		const response = await SELF.fetch("http://example.com", { redirect: 'manual' });
		expect(response.status).toBe(301);
		expect(response.headers.get('location')).toBe('https://example.com/');
	});

	it("refuses unauthenticated initkey requests", async () => {
		const ctx = createExecutionContext();
		const envWithKeys = {
			SIG_SK: 'secret-sk',
			SIG_PK: 'public-pk',
			SECRET: 'secret-32-bytes-example-123456',
		};
		const req = new Request('https://example.com/api/initkey', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ owner: 'Alice', 'allow-subkey': true }),
		});
		const res = await worker.fetch(req, envWithKeys, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(403);
	});

	it("strips CF metadata headers but preserves Authorization/Cookie by default", () => {
		const headers = new Headers({
			Authorization: '******',
			Cookie: 'session=abc',
			'X-Forwarded-For': '1.2.3.4',
			'CF-Connecting-IP': '1.2.3.4',
			Accept: 'application/json',
		});
		const forwarded = copyForwardHeaders(headers);
		// Authorization and Cookie are forwarded per user preference
		expect(forwarded.get('authorization')).toBe('******');
		expect(forwarded.get('cookie')).toBe('session=abc');
		// Cloudflare metadata and x-forwarded headers are stripped to reduce detection
		expect(forwarded.get('x-forwarded-for')).toBeNull();
		expect(forwarded.get('cf-connecting-ip')).toBeNull();
		expect(forwarded.get('accept')).toBe('application/json');
	});
});
