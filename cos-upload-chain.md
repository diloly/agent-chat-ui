# 腾讯云 COS 上传链路（Nuxt 3 / Nitro 服务端直传，返回公开 URL）

> 适用场景：前端选择图片/视频文件 → 调内部 API → 服务端用 `cos-nodejs-sdk-v5` 的 `putObject` 直传到桶 → 返回拼接好的公网 URL → 前端回填。
> 本链路来自 `apps/web`：`/console/settings/lighting-homepage` 背景媒体上传。

---

## 1. 依赖

`apps/web/package.json` 里需要：

```json
"cos-nodejs-sdk-v5": "^2.15.4"
```

```bash
npm i cos-nodejs-sdk-v5
# 或 pnpm add cos-nodejs-sdk-v5
```

---

## 2. 环境变量 / 运行时配置

密钥**只在服务端**使用，不暴露给浏览器。

`nuxt.config.ts` 的 `runtimeConfig`（私密，不会下发给客户端）：

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    // 服务端环境变量（私密，不会暴露给客户端）
    cosSecretId: process.env.COS_SECRET_ID || '',
    cosSecretKey: process.env.COS_SECRET_KEY || '',
    cosRegion: process.env.COS_REGION || 'ap-guangzhou',
    cosBucket: process.env.COS_BUCKET || '',
    cosDomain: process.env.COS_DOMAIN || '',
  },
});
```

需要在 `.env` / 部署环境中配置的实际变量：

```bash
COS_SECRET_ID=AKIDxxxxxxx          # 腾讯云 SecretId
COS_SECRET_KEY=xxxxxxx             # 腾讯云 SecretKey
COS_REGION=ap-guangzhou            # 桶所在地域
COS_BUCKET=aaldart02-1302625028    # 桶名（含 AppId）
COS_DOMAIN=https://aaldart02-1302625028.cos.ap-guangzhou.myqcloud.com  # 桶访问域名
```

> 桶的访问权限需设为「公有读」（或绑定自定义域名 + CDN），否则返回的 URL 无法直接打开。

---

## 3. 后端：服务端上传路由（核心）

文件路径：`server/api/cos/upload.post.ts`（Nuxt/Nitro 的文件路由约定，`server/api/cos/upload.post.ts` = `POST /api/cos/upload`）。

```ts
import COS from 'cos-nodejs-sdk-v5';
import { v4 as uuidv4 } from 'uuid';

// 初始化 COS 客户端
const getCosClient = () => {
    const config = useRuntimeConfig();

    const secretId = config.cosSecretId || process.env.COS_SECRET_ID || '';
    const secretKey = config.cosSecretKey || process.env.COS_SECRET_KEY || '';

    if (!secretId || !secretKey) {
        throw new Error('COS 密钥未配置');
    }

    return new COS({
        SecretId: secretId,
        SecretKey: secretKey,
    });
};

// 获取 COS 配置
const getCosConfig = () => {
    const config = useRuntimeConfig();
    return {
        region: config.cosRegion || process.env.COS_REGION || 'ap-guangzhou',
        bucket: config.cosBucket || process.env.COS_BUCKET || '',
        domain: config.cosDomain || process.env.COS_DOMAIN || '',
    };
};

// 规范化域名：修复脏协议、补 https、去尾部斜杠
const normalizeCosDomain = (rawDomain: string): string => {
    const trimmed = String(rawDomain || '').trim();
    if (!trimmed) return '';

    // 修复历史配置脏值：`https:/xx` -> `https://xx`
    const repairedProtocol = trimmed.replace(
        /^([a-zA-Z][a-zA-Z\d+.-]{1,}):\/(?!\/)/,
        '$1://',
    );

    // 未配置协议时默认补 https，避免返回相对地址
    const withProtocol = /^https?:\/\//i.test(repairedProtocol)
        ? repairedProtocol
        : `https://${repairedProtocol.replace(/^\/+/, '')}`;

    return withProtocol.replace(/\/+$/, '');
};

export default defineEventHandler(async (event) => {
    try {
        const maxFileSize = 200 * 1024 * 1024; // 200MB 限制

        let formData;
        try {
            formData = await readMultipartFormData(event);
        } catch (readError: any) {
            if (readError.message && readError.message.includes('Invalid array length')) {
                throw createError({
                    statusCode: 413,
                    statusMessage: `文件过大，无法处理。请确保文件大小不超过 ${maxFileSize / 1024 / 1024}MB`,
                });
            }
            throw readError;
        }

        if (!formData || formData.length === 0) {
            throw createError({ statusCode: 400, statusMessage: '没有上传文件' });
        }

        const fileData = formData.find((item) => item.name === 'file');
        if (!fileData || !fileData.data) {
            throw createError({ statusCode: 400, statusMessage: '文件数据无效' });
        }

        let fileSize: number;
        try {
            fileSize = fileData.data.length;
        } catch (sizeError: any) {
            throw createError({ statusCode: 500, statusMessage: `无法获取文件大小: ${sizeError.message || 'Invalid array length'}` });
        }

        if (fileSize > maxFileSize) {
            throw createError({
                statusCode: 413,
                statusMessage: `文件大小超过限制，最大允许 ${maxFileSize / 1024 / 1024}MB，当前文件大小：${(fileSize / 1024 / 1024).toFixed(2)}MB`,
            });
        }

        const isValidData = Buffer.isBuffer(fileData.data) ||
            (fileData.data && typeof fileData.data === 'object' && 'length' in fileData.data);
        if (!isValidData) {
            throw createError({ statusCode: 400, statusMessage: '文件数据格式无效' });
        }

        const cosConfig = getCosConfig();
        if (!cosConfig.bucket) {
            throw createError({ statusCode: 500, statusMessage: 'COS Bucket 未配置' });
        }

        // 生成文件名：uploads/images/{uuid}.{ext}
        const originalName = fileData.filename || 'file';
        const fileExtension = originalName.split('.').pop() || 'jpg';
        const fileName = `uploads/images/${uuidv4()}.${fileExtension}`;

        const cos = getCosClient();

        // 转 Buffer（兼容 Uint8Array）
        let fileBuffer: Buffer;
        try {
            if (Buffer.isBuffer(fileData.data)) {
                fileBuffer = fileData.data;
            } else {
                const data = fileData.data as any;
                if (!data || typeof data !== 'object') throw new Error('文件数据格式不支持');
                if (data instanceof Uint8Array) {
                    fileBuffer = Buffer.from(data);
                } else if ('length' in data && typeof data.length === 'number') {
                    if (data.length > maxFileSize) throw new Error(`文件数据长度异常: ${data.length} 字节`);
                    fileBuffer = Buffer.from(data);
                } else {
                    throw new Error('文件数据格式不支持');
                }
            }
        } catch (bufferError: any) {
            throw createError({ statusCode: 500, statusMessage: `无法处理文件数据: ${bufferError.message || 'Invalid array length'}` });
        }

        // 直传到 COS
        const uploadResult = await new Promise<COS.PutObjectResult>((resolve, reject) => {
            cos.putObject(
                {
                    Bucket: cosConfig.bucket,
                    Region: cosConfig.region,
                    Key: fileName,
                    Body: fileBuffer,
                    ContentType: fileData.type || 'application/octet-stream',
                },
                (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                },
            );
        });

        // 由域名 + key 拼出公网 URL（不依赖 COS 回包里的 ETag 路径）
        const normalizedDomain = normalizeCosDomain(cosConfig.domain);
        if (!normalizedDomain) {
            throw createError({ statusCode: 500, statusMessage: 'COS_DOMAIN 未配置，无法生成公开访问地址' });
        }
        const publicUrl = `${normalizedDomain}/${fileName}`;

        return {
            success: true,
            url: publicUrl,
            key: fileName,
            etag: uploadResult.ETag,
            size: fileData.data.length,
            contentType: fileData.type || 'application/octet-stream',
        };
    } catch (error: any) {
        console.error('❌ 上传失败:', error);
        throw createError({
            statusCode: error.statusCode || 500,
            statusMessage: error.message || '文件上传失败',
        });
    }
});
```

> 依赖 `h3` 的两个辅助函数：`readMultipartFormData`、`createError`、`defineEventHandler`（Nuxt 3 默认已带，无需额外安装）。

---

## 4. 前端：上传函数

在需要上传的页面里放这个函数（`apps/web/app/console/settings/lighting-homepage.vue:547`）：

```ts
/**
 * 上传文件到 COS 存储桶
 * @param file 要上传的文件
 * @returns 上传成功后返回文件的公开访问 URL
 */
async function uploadFileToCos(file: File): Promise<string> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch('/api/cos/upload', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.statusMessage || response.statusText || '上传失败';
        throw new Error(`COS上传失败: ${errorMessage}`);
    }

    const responseText = await response.text();
    let result;
    try {
        result = JSON.parse(responseText);
    } catch {
        throw new Error('上传返回数据格式错误');
    }

    // 响应可能是 { success, url } 或 { data: { success, url } }
    const data = result.data || result;

    if (!data.success || !data.url) {
        throw new Error('上传返回数据格式错误');
    }

    // 确保 URL 使用 HTTPS
    return data.url.replace(/^http:/, 'https:');
}
```

---

## 5. 调用示例（单个媒体上传并回填 URL）

`apps/web/app/console/settings/lighting-homepage.vue:658` —— 选文件后调 `uploadFileToCos`，把返回的 URL 写入数据模型：

```ts
const uploadSingleMedia = () => {
    const accept = singleMedia.type === 'image' ? 'image/*' : 'video/*';
    selectFile(accept, async (file) => {
        try {
            message.info(`正在上传${singleMedia.type === 'image' ? '图片' : '视频'}到 COS...`);
            const url = await uploadFileToCos(file);
            singleMedia.url = url; // 回填到数据模型
            message.success('上传成功');
        } catch (error: any) {
            message.error(error?.message || '上传失败，请重试');
        }
    });
};
```

> `selectFile` 是项目里的文件选择封装（打开系统文件框，回传 `File` 对象）。在另一个应用里替换成你自己的文件选择逻辑即可，核心只是「拿到 `File` → `uploadFileToCos(file)` → 用返回的 URL」。

---

## 6. 迁移到另一个应用（清单）

1. `npm i cos-nodejs-sdk-v5 uuid`
2. 复制 `server/api/cos/upload.post.ts` 到目标 Nuxt 项目的 `server/api/cos/upload.post.ts`
3. 在目标项目 `nuxt.config.ts` 加入 `runtimeConfig` 里的 5 个 `cos*` 字段
4. 配置 5 个 `COS_*` 环境变量
5. 前端复制 `uploadFileToCos` 函数，调用处拿到 `File` 后 `await uploadFileToCos(file)` 取 URL
6. 桶设为「公有读」或挂 CDN/自定义域名

### 非 Nuxt 项目怎么办？

核心只是 `cos-nodejs-sdk-v5` 的 `putObject`。把 `upload.post.ts` 里的逻辑移植到你后端框架的一个 POST 接口即可（读 multipart → `cos.putObject` → 拼 `domain + '/' + key` 返回）。前端不变，仍 `fetch('/你的上传接口', { method:'POST', body: formData })`。

---

## 7. 返回结构

```json
{
  "success": true,
  "url": "https://aaldart02-1302625028.cos.ap-guangzhou.myqcloud.com/uploads/images/<uuid>.png",
  "key": "uploads/images/<uuid>.png",
  "etag": "\"xxxxx\"",
  "size": 123456,
  "contentType": "image/png"
}
```
