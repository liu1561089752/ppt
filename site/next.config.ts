import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // standalone 追踪会把仓库里的 .git/data/db/download/deploy/logs 一并拷进产物,
  // 既泄漏内部文件又成倍膨胀部署包;绝不排除 node_modules(排除会导致依赖
  // 自举失败且 .deps-ready 无条件锁存,永久转换失败)
  outputFileTracingExcludes: {
    "*": [".git/**", ".work/**", "data/**", "db/**", "download/**", "deploy/logs*/**", "*.tsbuildinfo"],
  },
  // 安全响应头(M-G1-05)。
  // 注意:不能用 src/middleware.ts 实现——middleware 的存在会让 Next 16
  // 产出 Edge bundle,而 Edge 构建会把 instrumentation→maintenance→config 这条
  // Node-only 链(process.cwd/fs/path/Prisma)一起编译,Edge 里全部非法,
  // 导致所有路由 500(实测)。headers() 是纯配置,不产生 Edge 参与。
  async headers() {
    return [
      {
        source: "/:path*",
        missing: [{ type: "header", key: "x-nextjs-data" }],
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // 事件推送已由 SSE 改为轮询(独立短响应),gzip 缓冲问题不复存在;
  // 首屏 1.7MB 无压缩曾是移动端访问慢的主因,恢复压缩(旧注释已作废)。
  compress: true,
  reactStrictMode: false,
};

export default nextConfig;
