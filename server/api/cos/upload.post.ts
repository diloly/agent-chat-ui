/**
 * POST /api/cos/upload
 * 前端选文件 → FormData → 服务端直传腾讯云 COS → 返回公开 URL
 *
 * 依赖：cos-nodejs-sdk-v5  (pnpm add cos-nodejs-sdk-v5)
 * 环境变量见 .env 中 COS_* 配置
 */
import COS from 'cos-nodejs-sdk-v5';
import { v4 as uuidv4 } from 'uuid';

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

function getCos() {
  const c = useRuntimeConfig();
  return new COS({
    SecretId: c.cosSecretId || '',
    SecretKey: c.cosSecretKey || '',
  });
}

export default defineEventHandler(async (event) => {
  const c = useRuntimeConfig();
  if (!c.cosBucket) throw createError({ statusCode: 500, statusMessage: 'COS 未配置' });

  let formData;
  try { formData = await readMultipartFormData(event); }
  catch (e: any) {
    if (String(e.message).includes('Invalid array length'))
      throw createError({ statusCode: 413, statusMessage: '文件过大（最大 20MB）' });
    throw e;
  }

  const file = formData?.find((f) => f.name === 'file');
  if (!file?.data) throw createError({ statusCode: 400, statusMessage: '没有上传文件' });

  const buf = Buffer.isBuffer(file.data) ? Buffer.from(file.data) : file.data;
  if (buf.length > MAX_SIZE)
    throw createError({ statusCode: 413, statusMessage: `文件过大（最大 20MB，当前 ${(buf.length / 1024 / 1024).toFixed(1)}MB）` });

  const ext = (file.filename || 'bin').split('.').pop() || 'bin';
  const key = `chat-uploads/${uuidv4()}.${ext}`;

  await new Promise<void>((resolve, reject) => {
    getCos().putObject(
      { Bucket: c.cosBucket, Region: c.cosRegion || 'ap-guangzhou', Key: key, Body: buf, ContentType: file.type || '' },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  const domain = (c.cosDomain || '').replace(/\/+$/, '');
  return { success: true, url: `${domain}/${key}`, filename: file.filename, type: file.type };
});
