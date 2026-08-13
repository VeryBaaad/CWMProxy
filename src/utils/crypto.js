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
import { b64 } from './b64.js';

export async function importEd25519PublicKey(raw) {
	// Prefer SPKI DER (works reliably in Cloudflare Workers / modern WebCrypto).
	try {
		return await crypto.subtle.importKey('spki', raw, { name: 'Ed25519' }, true, ['verify']);
	} catch (e) {
		// Fallback for raw public key bytes (32 bytes) to remain compatible with older deployments.
		return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify']);
	}
}

export async function importEd25519PrivateKey(raw) {
	// Prefer PKCS8 DER (works reliably in Cloudflare Workers / modern WebCrypto).
	try {
		return await crypto.subtle.importKey('pkcs8', raw, { name: 'Ed25519' }, true, ['sign']);
	} catch (e) {
		// Fallback for raw private key bytes (32 bytes) for compatibility.
		return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['sign']);
	}
}

export async function signPayload(skRaw, payloadStr) {
	const key = await importEd25519PrivateKey(skRaw);
	const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payloadStr));
	return new Uint8Array(sig);
}
export async function verifyPayload(pkRaw, payloadStr, sigRaw) {
	const key = await importEd25519PublicKey(pkRaw);
	return crypto.subtle.verify('Ed25519', key, sigRaw, new TextEncoder().encode(payloadStr));
}

export async function importAesKeyFromSecret(secretRaw) {
	return crypto.subtle.importKey('raw', secretRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function aesGcmEncrypt(aesKey, plain) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
	return { iv: new Uint8Array(iv), ct: new Uint8Array(ct) };
}
export async function aesGcmDecrypt(aesKey, iv, ct) {
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
	return new Uint8Array(pt);
}
