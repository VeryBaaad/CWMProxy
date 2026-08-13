# CWMProxy

一个支持授权模式运行的 jsproxy。可简称为 **CWM** 或 **CWMP**。

## 配置

### 常量

| 名称     | 描述                                                   |
| -------- | ------------------------------------------------------ |
| SIG_SK   | PKCS#8 DER 格式的 ED25519 私钥，Base64 编码            |
| SIG_PK   | SPKI DER 格式的 ED25519 公钥，Base64 编码              |
| SECRET   | 32 字节（Base64 编码）                                 |

## 快速开始

### 初始密钥

运行以下命令获取初始密钥：

```sh [curl]
# 正确用法：请勿在请求体中发送 SIG_SK 或 SECRET。
# Worker 从其环境变量（wrangler secrets）中读取 SIG_SK / SIG_PK / SECRET。
curl "https://<your-worker>/api/initkey" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{ "owner": "Worker", "allow-subkey": true, "expired-at": -1 }'
```

### 子密钥

运行以下命令获取子密钥：

```sh [curl]
curl "https://<your-worker>/api/subkey" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{ "key": "<your key with allow sub key>", "subkey": true, "expired-at": 1893427200 }'
```

### 从互联网下载文件

#### Header 方式

```sh [curl]
curl "https://<your-worker>/https://example.com/index.html" \
  -H "CWMP-Authorization: Bearer <your-key>" \
```

#### URL 方式

```URL
https://<your-worker>/<your-key>/https://example.com/index.html
```

#### JSProxy 方式

```sh
$ export ..._PROXY=https://<your-worker>/<your-key>/
```

## Payload

令牌格式

令牌的形式为：base64url(JSON-payload) + '.' + base64url(signature)

- signature：使用 SIG_SK（私钥）对 JSON payload 计算的 ED25519 签名。
- verification：Worker 使用 SIG_PK（公钥）进行验证。

主密钥（初始密钥）payload 示例：

```JSON
{
  "owner": "Worker",
  "expired-at": -1,
  "allow-subkey": true,
  "created-with": "none",
  "enc_master": { "ciphertext": "...", "iv": "..." }
}
```

- enc_master 包含使用 env.SECRET（Base64 编码的 32 字节密钥）通过 AES-GCM 加密的主密钥密文。ciphertext 和 iv 均为 base64url 编码。
- 主密钥仅可由持有 env.SECRET 的 Worker 解密。

子密钥 payload 示例（由主密钥创建）：

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

关于子密钥的说明：
- 当从主密钥创建子密钥时，主密钥的 enc_master 会被嵌入到子密钥 payload 中（复制加密数据）。这使得子密钥是自包含的：Worker 可以从主令牌或子密钥令牌中解密主密钥，因为两者都包含使用 env.SECRET 加密的 enc_master。
- 子密钥的 expired-at 被设置为请求的子密钥过期时间与主密钥过期时间（如果主密钥有过期时间）的最小值。这确保了子密钥的生命周期不会超过其主密钥。
- 子密钥不会向客户端暴露主密钥：enc_master 保持加密状态，只有持有 env.SECRET 的 Worker 才能解密。


API 端点

- POST /api/initkey
  - 请求 JSON：{ owner?, "expired-at"?, "allow-subkey"? }
  - 响应 JSON：{ key: <master_token> }
  - 创建主令牌。Worker 生成随机主密钥，使用 env.SECRET 对其进行加密，并将 enc_master 包含在令牌 payload 中。令牌使用 SIG_SK 签名。

- POST /api/subkey
  - 请求 JSON：{ key: <master_token>, owner?, "expired-at"?, "allow-subkey"? }
  - 响应 JSON：{ key: <subkey_token> }
  - 基于主令牌创建子密钥。子密钥 payload 将嵌入来自主密钥的 enc_master（已加密），且其过期时间不会超过主密钥的过期时间。

- POST /api/payload
  - 请求 JSON：{ token: <token>, reveal_enc_master?: bool, sig_sk?: string, secret?: string }
  - 响应 JSON：{ payload: <decoded-payload> }
  - 返回令牌 payload。默认情况下，返回的 payload 中会移除 enc_master。若要接收包含 enc_master 的完整 payload，调用者必须提供与 Worker 环境中的 SIG_SK 和 SECRET 完全匹配的 sig_sk 和 secret。

- POST /api/compute-master
  - 请求 JSON：{ key|token: <token>, sig_sk: string, secret: string }
  - 响应 JSON：{ master: <base64(master_secret)> }
  - 从提供的令牌中解密 enc_master 并返回主密钥（Base64 编码）。这是一个敏感操作，需要提供与当前运行的 Worker 的 SIG_SK 和 SECRET 完全匹配的 sig_sk 和 secret。

代理用法

- /<key>/https://example.com/path  （第一个路径段为令牌）
- /https://example.com/path 并在 CWMP-Authorization 或 CWMP-Auth 头中携带密钥

请求头

- Worker 会将大多数请求头转发给上游，但会移除：
  - 以 'CWMP-Auth' 开头的头（例如 CWMP-Authorization），以避免向上游泄露密钥。
  - 逐跳头（Connection, Keep-Alive, Transfer-Encoding, Upgrade 等）。
  - Host 头不会被转发（fetch 会自动设置它）。

HTTP -> HTTPS 重定向

- 如果客户端通过 http:// 访问 Worker，Worker 将立即响应 301 重定向至 https:// URL，以防止密钥通过明文泄露。
- Worker 不会自动将代理目标 URL 从 http:// 升级为 https://；代理将按原样获取目标 URL。（仅对发往 Worker 的入站请求进行重定向。）

环境（部署）要求

- SIG_SK：Base64 编码的原始 Ed25519 私钥（用于签署令牌）。请妥善保管。
- SIG_PK：Base64 编码的原始 Ed25519 公钥（用于验证令牌）。
- SECRET：Base64 编码的 32 字节 AES 密钥，用于加密主密钥（enc_master）。

安全注意事项

- enc_master 使用 SECRET 加密，令牌持有者无法解密；只有拥有 SECRET 访问权限的 Worker 才能解密。
- 敏感端点（带 reveal 参数的 /api/payload、/api/compute-master）要求提供与 Worker 环境匹配的 SIG_SK 和 SECRET；这可防止子密钥或未授权的调用者提取主密钥。

密钥轮换与撤销

本项目使用 ED25519 签名来验证令牌。更换 Worker 的 ED25519 密钥是撤销先前颁发令牌的推荐方法，无需修改代码：

- 更换 SIG_PK（Worker 用于验证令牌签名的公钥）会立即使任何使用旧 SIG_SK 签名的令牌失效，因为 Worker 将不再使用旧公钥进行验证。这提供了一种有效的“全部撤销”机制，无需更改代码或使用 KV/R2。
- 如果您可能需要回滚，请安全备份旧密钥。

推荐的轮换流程

1) 生成兼容格式的新 ED25519 密钥对（私钥为 PKCS#8 DER 格式，公钥为 SPKI DER 格式）并进行 Base64 编码。
   - OpenSSL 示例：
     openssl genpkey -algorithm ED25519 -out private.pem
     openssl pkey -in private.pem -pubout -out public.pem
     openssl pkcs8 -topk8 -nocrypt -in private.pem -outform DER -out private.pk8.der
     openssl pkey -in public.pem -pubout -outform DER -out public.spki.der
     base64 -w0 private.pk8.der > sig_sk.b64
     base64 -w0 public.spki.der > sig_pk.b64

   - Node.js 示例（如果没有 OpenSSL）：
     // gen-ed25519.js
     const { generateKeyPairSync } = require('crypto');
     const fs = require('fs');
     const { publicKey, privateKey } = generateKeyPairSync('ed25519');
     fs.writeFileSync('private.pk8.der', privateKey.export({ type: 'pkcs8', format: 'der' }));
     fs.writeFileSync('public.spki.der', publicKey.export({ type: 'spki', format: 'der' }));
     fs.writeFileSync('sig_sk.b64', Buffer.from(fs.readFileSync('private.pk8.der')).toString('base64'));
     fs.writeFileSync('sig_pk.b64', Buffer.from(fs.readFileSync('public.spki.der')).toString('base64'));

2) 安全存储生成的文件（private.pem / sig_sk.b64）。切勿将其提交到版本控制系统。
   - 示例目录：~/.cwmproxy
   - chmod 600 ~/.cwmproxy/private.pem ~/.cwmproxy/sig_sk.b64

3) 更新 Worker Secrets（wrangler）以使用新密钥。此步骤在替换 SIG_PK 时执行撤销操作：
   wrangler secret put SIG_SK < ~/.cwmproxy/sig_sk.b64
   wrangler secret put SIG_PK < ~/.cwmproxy/sig_pk.b64

注意事项与策略选项

- 立即撤销：在 Worker 上替换 SIG_PK。旧令牌立即失效。
- 平滑过渡（需要代码更改）：如果您需要短暂的重叠窗口，请修改 Worker 以接受多个公钥（SIG_PK_PRIMARY 和 SIG_PK_ROLLING），并通过先添加新密钥、稍后移除旧密钥的方式进行轮换。这需要代码更改并重新部署。
- SECRET 轮换：轮换 SIG 密钥仅影响签名验证。如果您必须轮换 SECRET（用于加密 enc_master），则必须重新颁发新的主令牌或使用新 SECRET 重新加密主密钥。

安全最佳实践

- 切勿在 API 调用或请求体中暴露 SIG_SK 或 SECRET。Worker 仅从安全的环境变量中接受这些值。
- 尽可能离线备份密钥并进行加密。
- 如果怀疑密钥泄露，请立即执行轮换，并考虑同时轮换 SECRET 及重新颁发受影响的令牌。

示例：完整的基于 OpenSSL 的轮换及设置 Secrets

openssl genpkey -algorithm ED25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
openssl pkcs8 -topk8 -nocrypt -in private.pem -outform DER -out private.pk8.der
openssl pkey -in public.pem -pubout -outform DER -out public.spki.der
base64 -w0 private.pk8.der > sig_sk.b64
base64 -w0 public.spki.der > sig_pk.b64
mkdir -p ~/.cwmproxy && mv sig_sk.b64 sig_pk.b64 private.pem public.pem ~/.cwmproxy && chmod 600 ~/.cwmproxy/private.pem ~/.cwmproxy/sig_sk.b64
wrangler secret put SIG_SK < ~/.cwmproxy/sig_sk.b64
wrangler secret put SIG_PK < ~/.cwmproxy/sig_pk.b64

## 常见问题解答

### 为什么我的子密钥失效了？

因为主密钥已过期。

## License

CWMP is licensed under the **GNU Affero General Public License v3 (AGPL-3)** (https://www.gnu.org/licenses/agpl-3.0.html).
