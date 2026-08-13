# CWMProxy

A jsproxy that supports running in authorized mode. It can be abbreviated as **CWM** or **CWMP**.

## Configuration

### Constant

| Name   | Description                                                   |
| ------ | ------------------------------------------------------------- |
| SIG_SK | An ED25519 private key in PKCS#8 DER format, base64-encoded |
| SIG_PK | An ED25519 public key in SPKI DER format, base64-encoded     |
| SECRET | 32 bytes (encoded in base64)                                  |

## Quick Start

### Initial Key

Run the following command to get your initial key:

```sh [curl]
# Correct usage: do NOT send SIG_SK or SECRET in the request body.
# The Worker reads SIG_SK / SIG_PK / SECRET from its environment (wrangler secrets).
curl "https://<your-worker>/api/initkey" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{ "owner": "Worker", "allow-subkey": true, "expired-at": -1 }'
```

### Sub key

Run the following command to get your subkey:

```sh [curl]
curl "https://<your-worker>/api/subkey" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{ "key": "<your key with allow sub key>", "subkey": true, "expired-at": 1893427200 }'
```

### Download file from Internet

#### Head

```sh [curl]
curl "https://<your-worker>/https://example.com/index.html" \
  -H "CWMP-Authorization: Bearer <your-key>" \
```

#### URL

```URL
https://<your-worker>/<your-key>/https://example.com/index.html
```

#### JSProxy

```sh
$ export ..._PROXY=https://<your-worker>/<your-key>/
```

## Payload

Token format

Tokens are of the form: base64url(JSON-payload) + '.' + base64url(signature)

- signature: ED25519 signature computed over the JSON payload using SIG_SK (private key).
- verification: Worker verifies with SIG_PK (public key).

Master key (initial key) payload example:

```JSON
{
  "owner": "Worker",
  "expired-at": -1,
  "allow-subkey": true,
  "created-with": "none",
  "enc_master": { "ciphertext": "...", "iv": "..." }
}
```

- enc_master contains the master secret encrypted with AES-GCM using env.SECRET (base64 32-bytes). The ciphertext and iv are encoded base64url.
- The master secret is only decryptable by the Worker (it needs env.SECRET).

Subkey payload example (created from a master):

```JSON
{
  "owner": "John",
  "expired-at": 1893427200,
  "allow-subkey": true,
  "created-with": "<creator-signature-prefix>",
  "created-at": 1680000000,
  "enc_master": { "ciphertext": "...", "iv": "..." }
}
```

Notes about subkeys:
- When a subkey is created from a master, the master's enc_master is embedded into the subkey payload (encrypted data copied). This makes the subkey self-contained: the Worker can decrypt the master secret from either the master token or the subkey token because both contain enc_master encrypted with env.SECRET.
- The subkey's expired-at is set to the minimum of the requested subkey expiry and the master's expired-at (if the master has an expiry). This ensures a subkey cannot outlive its master.
- Subkeys do NOT expose the master secret to clients: enc_master remains encrypted and is only decryptable by the Worker that holds env.SECRET.


API Endpoints

- POST /api/initkey
  - Request JSON: { owner?, "expired-at"?, "allow-subkey"? }
  - Response JSON: { key: <master_token> }
  - Creates a master token. The Worker generates a random master secret, encrypts it with env.SECRET and includes enc_master in the token payload. The token is signed with SIG_SK.

- POST /api/subkey
  - Request JSON: { key: <master_token>, owner?, "expired-at"?, "allow-subkey"? }
  - Response JSON: { key: <subkey_token> }
  - Creates a subkey derived from a master token. The subkey payload will embed enc_master from the master (encrypted), and its expiry will not exceed the master's expiry.

- POST /api/payload
  - Request JSON: { token: <token>, reveal_enc_master?: bool, sig_sk?: string, secret?: string }
  - Response JSON: { payload: <decoded-payload> }
  - Returns the token payload. By default enc_master is removed from the returned payload. To receive the full payload including enc_master, the caller must provide sig_sk and secret that exactly match the Worker environment SIG_SK and SECRET.

- POST /api/compute-master
  - Request JSON: { key|token: <token>, sig_sk: string, secret: string }
  - Response JSON: { master: <base64(master_secret)> }
  - Decrypts enc_master from the provided token and returns the master secret (base64). This is a sensitive operation and requires providing sig_sk and secret that exactly match the running Worker's SIG_SK and SECRET.

Proxy usage

- /<key>/https://example.com/path  (first path segment is token)
- /https://example.com/path with CWMP-Authorization or CWMP-Auth header carrying the key

Headers

- Worker forwards most headers to the upstream, but removes:
  - Headers starting with 'CWMP-Auth' (e.g., CWMP-Authorization) to avoid leaking keys to upstream.
  - Hop-by-hop headers (Connection, Keep-Alive, Transfer-Encoding, Upgrade, etc.).
  - Host header is not forwarded (fetch will set it).

HTTP -> HTTPS redirection

- If a client accesses the Worker over http://, the Worker will immediately respond with a 301 redirect to the https:// URL to prevent key leakage over plaintext.
- The Worker does NOT automatically upgrade proxy target URLs from http:// to https://; the proxy will fetch the target URL as provided. (Only the inbound request to the Worker is redirected.)

Environment (deployment) requirements

- SIG_SK: base64-encoded raw Ed25519 private key (used to sign tokens). Keep secret.
- SIG_PK: base64-encoded raw Ed25519 public key (used to verify tokens).
- SECRET: base64-encoded 32-byte AES key used to encrypt master secrets (enc_master).

Security notes

- enc_master is encrypted with SECRET and cannot be decrypted by token holders; only the Worker with access to SECRET can decrypt it.
- Sensitive endpoints (/api/payload with reveal, /api/compute-master) require providing SIG_SK and SECRET matching the Worker environment; this prevents subkeys or unauthorized callers from extracting master secrets.

Key rotation & revocation

This project uses ED25519 signatures to authenticate tokens. Replacing the Worker ED25519 keys is the recommended, code-free way to revoke previously issued tokens:

- Replacing SIG_PK (the public key used by the Worker to verify token signatures) immediately invalidates any token signed with the old SIG_SK, because the Worker will no longer verify with the old public key. This provides an effective "revoke all" mechanism without changing code or using KV/R2.
- Keep a secure backup of the old keys if you may need to roll back.

Recommended rotation procedure

1) Generate a new ED25519 key pair in compatible formats (PKCS#8 DER for private key, SPKI DER for public key) and base64 them.
   - OpenSSL example:
     openssl genpkey -algorithm ED25519 -out private.pem
     openssl pkey -in private.pem -pubout -out public.pem
     openssl pkcs8 -topk8 -nocrypt -in private.pem -outform DER -out private.pk8.der
     openssl pkey -in public.pem -pubout -outform DER -out public.spki.der
     base64 -w0 private.pk8.der > sig_sk.b64
     base64 -w0 public.spki.der > sig_pk.b64

   - Node.js example (if OpenSSL not available):
     // gen-ed25519.js
     const { generateKeyPairSync } = require('crypto');
     const fs = require('fs');
     const { publicKey, privateKey } = generateKeyPairSync('ed25519');
     fs.writeFileSync('private.pk8.der', privateKey.export({ type: 'pkcs8', format: 'der' }));
     fs.writeFileSync('public.spki.der', publicKey.export({ type: 'spki', format: 'der' }));
     fs.writeFileSync('sig_sk.b64', Buffer.from(fs.readFileSync('private.pk8.der')).toString('base64'));
     fs.writeFileSync('sig_pk.b64', Buffer.from(fs.readFileSync('public.spki.der')).toString('base64'));

2) Securely store the generated files (private.pem / sig_sk.b64). Do NOT check them into source control.
   - Example directory: ~/.cwmproxy
   - chmod 600 ~/.cwmproxy/private.pem ~/.cwmproxy/sig_sk.b64

3) Update Worker secrets (wrangler) to use the new keys. This step performs the revocation when SIG_PK is replaced:
   wrangler secret put SIG_SK < ~/.cwmproxy/sig_sk.b64
   wrangler secret put SIG_PK < ~/.cwmproxy/sig_pk.b64

Notes and strategy options

- Immediate revocation: Replace SIG_PK on the Worker. Old tokens become invalid immediately.
- Smooth rollout (requires code change): if you need a brief overlap window, modify the Worker to accept multiple public keys (SIG_PK_PRIMARY and SIG_PK_ROLLING) and rotate by adding the new key first, then removing the old key later. This requires a code change and re-deploy.
- SECRET rotation: rotating SIG keys only affects signature verification. If you must rotate SECRET (used to encrypt enc_master), you must re-issue new master tokens or re-encrypt the master secrets with the new SECRET.

Security best practices

- Never expose SIG_SK or SECRET in API calls or request bodies. The Worker only accepts these from secure environment secrets.
- Back up keys offline and encrypted if possible.
- If a key is suspected leaked, perform an immediate rotation and consider also rotating SECRET and re-issuing affected tokens.

Example: complete OpenSSL-based rotation & set secrets

openssl genpkey -algorithm ED25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
openssl pkcs8 -topk8 -nocrypt -in private.pem -outform DER -out private.pk8.der
openssl pkey -in public.pem -pubout -outform DER -out public.spki.der
base64 -w0 private.pk8.der > sig_sk.b64
base64 -w0 public.spki.der > sig_pk.b64
mkdir -p ~/.cwmproxy && mv sig_sk.b64 sig_pk.b64 private.pem public.pem ~/.cwmproxy && chmod 600 ~/.cwmproxy/private.pem ~/.cwmproxy/sig_sk.b64
wrangler secret put SIG_SK < ~/.cwmproxy/sig_sk.b64
wrangler secret put SIG_PK < ~/.cwmproxy/sig_pk.b64

## Q&A

### Why my subkey is died?

Because the master key expired.

## License

CWMP is licensed under the **GNU Affero General Public License v3 (AGPL-3)** (https://www.gnu.org/licenses/agpl-3.0.html).
