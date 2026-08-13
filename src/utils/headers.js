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
export const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailers',
	'transfer-encoding',
	'upgrade',
]);

export function removeCwmpHeaders(headers) {
	for (const key of Array.from(headers.keys())) {
		const lower = key.toLowerCase();
		if (lower.startsWith('cwmp-auth')) headers.delete(key);
		if (lower.startsWith('cf-')) headers.delete(key); // remove Cloudflare metadata headers
		if (lower === 'true-client-ip') headers.delete(key);
	}
}

export function copyForwardHeaders(inHeaders) {
	const out = new Headers();
	for (const [k, v] of inHeaders.entries()) {
		const lk = k.toLowerCase();
		if (HOP_BY_HOP.has(lk)) continue;
		if (lk.startsWith('cwmp-auth')) continue;
		if (lk.startsWith('cf-')) continue; // don't forward Cloudflare metadata
		if (lk.startsWith('x-forwarded-')) continue; // strip forwarded-for/host headers used for client IP
		if (lk === 'cf-connecting-ip' || lk === 'true-client-ip') continue;
		if (lk === 'host') continue;
		out.append(k, v);
	}
	return out;
}
