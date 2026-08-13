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
export const b64 = {
	encode: (arr) => {
		const s = typeof arr === 'string' ? arr : String.fromCharCode.apply(null, new Uint8Array(arr));
		return btoa(s).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
	},
	decodeToUint8: (s) => {
		if (!s) return new Uint8Array();
		s = s.replace(/-/g, '+').replace(/_/g, '/');
		while (s.length % 4) s += '=';
		const bin = atob(s);
		const arr = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
		return arr;
	},
	encodeStr: (str) => b64.encode(new TextEncoder().encode(str)),
	decodeStr: (s) => new TextDecoder().decode(b64.decodeToUint8(s)),
};
