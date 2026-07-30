export default defineNuxtConfig({
  // 纯前端 SPA，聊天交互全在客户端
  ssr: false,
  devtools: { enabled: false },

  // 开发服务器端口（3000 被占用，改用 3001）
  devServer: {
    port: 3001,
    host: '127.0.0.1',
  },
  // 生产构建 (pnpm build) 后 node 服务端口
  server: {
    port: 3001,
    host: '127.0.0.1',
  },

  // 服务端密钥通过 NUXT_ 前缀从 .env 注入，浏览器拿不到
  runtimeConfig: {
    cozeToken: '',
    cozeProjectId: '',
    cozeBase: 'https://86mk5gbpdy.coze.site',
    // COS 文件上传（服务端直传，密钥不暴露给浏览器）
    cosSecretId: '',
    cosSecretKey: '',
    cosRegion: 'ap-guangzhou',
    cosBucket: '',
    cosDomain: '',
  },
});
