/* CWMProxy
 * Copyright (C) 2026 VeryBaaad <verybaaad@outlook.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
import { b64 } from './utils/b64.js';
import * as cryptoUtils from './utils/crypto.js';
import * as tokens from './utils/tokens.js';
import { copyForwardHeaders, removeCwmpHeaders, HOP_BY_HOP } from './utils/headers.js';

function parseIpv4(ip) {
	if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return null;
	const octets = ip.split('.').map(Number);
	if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
	return octets;
}

function isReservedOrPrivateIpv4(ip) {
	const octets = parseIpv4(ip);
	if (!octets) return false;
	const [a, b] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b >= 20 && b <= 23) return true;
	if (a >= 224 || a === 255) return true;
	return false;
}

function isReservedOrPrivateIpv6(ip) {
	const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
	if (!normalized) return false;
	if (normalized === '::1') return true;
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
	if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
	if (normalized === '::' || normalized.startsWith('2001:db8')) return true;
	return false;
}

export function assertAllowedProxyTarget(targetUrl) {
	let parsed;
	try {
		parsed = new URL(targetUrl);
	} catch {
		throw new Error('invalid target url');
	}
	if (parsed.protocol !== 'https:') {
		throw new Error('only https proxy targets are allowed');
	}
	const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (!host || host === 'localhost' || host.endsWith('.localhost')) {
		throw new Error('localhost targets are not allowed');
	}
	if (isReservedOrPrivateIpv4(host) || isReservedOrPrivateIpv6(host)) {
		throw new Error('private or local network targets are not allowed');
	}
	if (host === '169.254.169.254' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
		throw new Error('internal metadata endpoints are not allowed');
	}
	return parsed;
}

// Main worker
export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// If this request arrived over HTTP, redirect to HTTPS to avoid leaking keys.
		// (Applies globally, before any other handling.)
		if (url.protocol === 'http:') {
			const httpsUrl = 'https://' + url.host + url.pathname + url.search;
			return Response.redirect(httpsUrl, 301);
		}

		// preserve root Hello World for simple checks
		if (url.pathname === '/' || url.pathname === '') {
			return new Response('Hello World!');
		}

		// API endpoints
		if (url.pathname === '/api/initkey' && request.method === 'POST') {
			try {
				const body = await request.json();
				// Sensitive bootstrap endpoint: require exact admin credentials or reject.
				if (!body.secret || !body.sig_sk) {
					return new Response('missing credentials', { status: 403 });
				}
				if (body.secret !== env.SECRET || body.sig_sk !== env.SIG_SK) {
					return new Response('invalid credentials', { status: 403 });
				}
				const payload = {
					owner: body.owner || 'Worker',
					'created-with': body['created-with'] || 'none',
					'allow-subkey': body['allow-subkey'] !== undefined ? body['allow-subkey'] : true,
					'expired-at': body['expired-at'] !== undefined ? body['expired-at'] : -1,
				};
				const token = await tokens.createMasterToken(env, payload);
				return new Response(JSON.stringify({ key: token }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(e.message || 'initkey error', { status: 400 });
			}
		}

		if (url.pathname === '/api/subkey' && request.method === 'POST') {
			try {
				const body = await request.json();
				const masterKey = body.key;
				if (!masterKey) return new Response('missing master key', { status: 400 });
				const subPayload = {
					owner: body.owner || 'sub',
					'allow-subkey': body['allow-subkey'] !== undefined ? body['allow-subkey'] : false,
					'expired-at': body['expired-at'] !== undefined ? body['expired-at'] : -1,
					'created-with': null,
				};
				const sub = await tokens.createSubkeyFromMaster(env, masterKey, subPayload);
				return new Response(JSON.stringify({ key: sub }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(e.message || 'subkey error', { status: 400 });
			}
		}

		// Sensitive ops: decode payload / compute master secret
		if (url.pathname === '/api/payload' && request.method === 'POST') {
			try {
				const body = await request.json();
				const token = body.token;
				if (!token) return new Response('missing token', { status: 400 });
				const payload = tokens.decodePayloadWithoutVerify(token);
				const reveal = body.reveal_enc_master === true;
				if (reveal) {
					if (!body.sig_sk || !body.secret) return new Response('missing credentials', { status: 403 });
					if (body.sig_sk !== env.SIG_SK || body.secret !== env.SECRET) return new Response('invalid credentials', { status: 403 });
					return new Response(JSON.stringify({ payload }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				if (payload && payload.enc_master) delete payload.enc_master;
				return new Response(JSON.stringify({ payload }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(e.message || 'payload error', { status: 400 });
			}
		}

		if (url.pathname === '/api/compute-master' && request.method === 'POST') {
			try {
				const body = await request.json();
				const token = body.key || body.token;
				if (!token) return new Response('missing token', { status: 400 });
				if (!body.sig_sk || !body.secret) return new Response('missing credentials', { status: 403 });
				if (body.sig_sk !== env.SIG_SK || body.secret !== env.SECRET) return new Response('invalid credentials', { status: 403 });
				const pt = await tokens.decryptMasterSecret(env, token);
				return new Response(JSON.stringify({ master: b64.encode(pt) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			} catch (e) {
				return new Response(e.message || 'compute error', { status: 400 });
			}
		}

		// Proxy routes
		let targetUrl = null;
		let token = null;
		const pathname = url.pathname.replace(/^\//, '');
		if (pathname.startsWith('http://') || pathname.startsWith('https://')) {
			// restore possible collapsed slashes from Cloudflare
			const urlStr = pathname.replace(/^(https?):\/+/, '$1://');
			targetUrl = urlStr;
			const hdr = request.headers.get('CWMP-Authorization') || request.headers.get('CWMP-Auth');
			if (hdr) token = hdr.trim();
		} else {
			const idx = pathname.indexOf('/');
			if (idx !== -1) {
				token = decodeURIComponent(pathname.slice(0, idx));
				// restore collapsed slashes
				targetUrl = pathname.slice(idx + 1).replace(/^(https?):\/+/, '$1://');
			} else {
				return new Response('invalid proxy request', { status: 400 });
			}
		}

		if (!targetUrl) return new Response('missing target url', { status: 400 });
		// verify token
		if (!token) return new Response('missing key', { status: 403 });
		const payload = await tokens.verifyToken(env, token);
		if (!payload) return new Response('invalid key', { status: 403 });

		// Proxy the request
		try {
			const outHeaders = copyForwardHeaders(request.headers);
			removeCwmpHeaders(outHeaders);
			const init = {
				method: request.method,
				headers: outHeaders,
				body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
				redirect: 'manual',
			};
			const resp = await fetch(targetUrl, init);
			const resHeaders = new Headers();
			for (const [k, v] of resp.headers.entries()) {
				if (HOP_BY_HOP.has(k.toLowerCase())) continue;
				resHeaders.append(k, v);
			}
			return new Response(resp.body, { status: resp.status, headers: resHeaders });
		} catch (e) {
			return new Response('fetch error: ' + e.message, { status: 502 });
		}
	},
};
