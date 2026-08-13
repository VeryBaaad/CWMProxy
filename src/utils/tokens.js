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
import * as cryptoUtils from './crypto.js';
import { b64 as b64local } from './b64.js';

export async function createMasterToken(env, payload) {
	const secretB = b64.decodeToUint8(env.SECRET || '');
	if (!secretB || secretB.length === 0) throw new Error('env.SECRET missing or invalid');
	const aesKey = await cryptoUtils.importAesKeyFromSecret(secretB);
	const masterSecret = crypto.getRandomValues(new Uint8Array(32));
	const { iv, ct } = await cryptoUtils.aesGcmEncrypt(aesKey, masterSecret);
	payload.enc_master = {
		ciphertext: b64.encode(ct),
		iv: b64.encode(iv),
	};
	const payloadStr = JSON.stringify(payload);
	const skRaw = b64.decodeToUint8(env.SIG_SK || '');
	if (!skRaw || skRaw.length === 0) throw new Error('env.SIG_SK missing or invalid');
	const sig = await cryptoUtils.signPayload(skRaw, payloadStr);
	const token = b64.encodeStr(payloadStr) + '.' + b64.encode(sig);
	return token;
}

export async function createSubkeyFromMaster(env, masterToken, subPayload) {
	const parts = masterToken.split('.');
	if (parts.length !== 2) throw new Error('invalid master token format');
	const payloadStr = b64.decodeStr(parts[0]);
	const sig = b64.decodeToUint8(parts[1]);
	const pkRaw = b64.decodeToUint8(env.SIG_PK || '');
	if (!pkRaw || pkRaw.length === 0) throw new Error('env.SIG_PK missing or invalid');
	const ok = await cryptoUtils.verifyPayload(pkRaw, payloadStr, sig);
	if (!ok) throw new Error('master token signature invalid');
	const payload = JSON.parse(payloadStr);
	if (!payload['allow-subkey']) throw new Error('master does not allow subkey');
	if (payload['expired-at'] > 0 && Date.now() / 1000 > payload['expired-at']) throw new Error('master expired');
	const now = Math.floor(Date.now() / 1000);
	// Prepare final subkey payload
	const final = Object.assign({}, subPayload, { 'created-with': null });
	final['created-with'] = parts[1].slice(0, 16);
	final['created-at'] = now;
	// Ensure subkey expires no later than master: if subPayload.expired-at is -1 (no expiry), inherit master's expiry.
	if (!final['expired-at'] || final['expired-at'] === -1) {
		final['expired-at'] = payload['expired-at'] || -1;
	} else if (payload['expired-at'] > 0) {
		// both have expiry -> set to min
		final['expired-at'] = Math.min(final['expired-at'], payload['expired-at']);
	}
	// Embed the master's encrypted secret (enc_master) directly into the subkey payload so subkey is self-contained.
	// This is safe because enc_master is encrypted with env.SECRET and cannot be decrypted by clients.
	if (payload.enc_master) {
		final.enc_master = payload.enc_master;
	}
	const payloadStr2 = JSON.stringify(final);
	const skRaw = b64.decodeToUint8(env.SIG_SK || '');
	const sig2 = await cryptoUtils.signPayload(skRaw, payloadStr2);
	return b64.encodeStr(payloadStr2) + '.' + b64.encode(sig2);
}

export async function verifyToken(env, token) {
	const parts = token.split('.');
	if (parts.length !== 2) return false;
	const payloadStr = b64.decodeStr(parts[0]);
	const sig = b64.decodeToUint8(parts[1]);
	const pkRaw = b64.decodeToUint8(env.SIG_PK || '');
	if (!pkRaw || pkRaw.length === 0) return false;
	try {
		const ok = await cryptoUtils.verifyPayload(pkRaw, payloadStr, sig);
		if (!ok) return false;
		const payload = JSON.parse(payloadStr);
		// token expiry
		if (payload['expired-at'] > 0 && Date.now() / 1000 > payload['expired-at']) return false;
		// if subkey references master expiry, enforce it
		if (payload['master_expired_at'] > 0 && Date.now() / 1000 > payload['master_expired_at']) return false;
		return payload;
	} catch (e) {
		return false;
	}
}

export function decodePayloadWithoutVerify(token) {
	const parts = token.split('.');
	if (parts.length !== 2) throw new Error('invalid token');
	const payloadStr = b64.decodeStr(parts[0]);
	return JSON.parse(payloadStr);
}

export async function decryptMasterSecret(env, masterToken) {
	const payload = decodePayloadWithoutVerify(masterToken);
	if (!payload.enc_master) throw new Error('no enc_master');
	const secretB = b64.decodeToUint8(env.SECRET || '');
	if (!secretB || secretB.length === 0) throw new Error('env.SECRET missing or invalid');
	const aesKey = await cryptoUtils.importAesKeyFromSecret(secretB);
	const iv = b64.decodeToUint8(payload.enc_master.iv);
	const ct = b64.decodeToUint8(payload.enc_master.ciphertext);
	const pt = await cryptoUtils.aesGcmDecrypt(aesKey, iv, ct);
	return pt; // Uint8Array of master secret
}
