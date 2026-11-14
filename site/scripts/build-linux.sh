#!/bin/bash
# 生产构建(云服务器):tsc 类型检查 → next build → 同步静态资源 → 校验原生引擎就绪。
# 这是**唯一**构建入口:不要在别处复制构建逻辑(资源/引擎漏同步曾导致线上预览与下载失败)。
# 仓库根由脚本自身位置推导,换部署目录无需改脚本。
#
# 原生链路注意:
#   - 站点不再打包任何 HTML→PPTX 转换器(skills/pptx/html2pptx1.js 已删除),
#     生成靠兄弟目录的原生引擎(pptx/native),由 NATIVE_ENGINE_DIR 指定;
#   - 引擎自带 node_modules(pptxgenjs/fontkit/image-size/jszip),部署时必须一起放上去,
#     所以这里用 engine-doctor 做一次真探针(--check),缺依赖会在这里就失败,
#     而不是等用户点了生成才 500。
set -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"

do_build() {
  cd "$REPO" || return 1
  export PATH="$(dirname "$BUN"):$PATH"

  if ! bun node_modules/typescript/bin/tsc --noEmit; then
    echo "TSC_FAIL"
    return 1
  fi
  echo TSC_OK

  if ! bun node_modules/next/dist/bin/next build > /tmp/v2-build.log 2>&1; then
    echo "BUILD_FAIL"
    tail -20 /tmp/v2-build.log
    return 1
  fi
  tail -3 /tmp/v2-build.log

  cp -r .next/static .next/standalone/.next/ || return 1
  cp -r public .next/standalone/ || return 1

  # 引擎就绪探针:print resolved root + --check(最小 spec 过 schema 与依赖加载)
  if ! node scripts/engine-doctor.mjs; then
    echo "ENGINE_NOT_READY"
    echo "  检查 NATIVE_ENGINE_DIR(当前:${NATIVE_ENGINE_DIR:-<未设置,默认 ../pptx/native>})"
    echo "  引擎目录需含 cli.js / index.js / core / engine / components / templates / themes 及其 node_modules"
    return 1
  fi
  echo "ENGINE_OK"

  # Next 会显式 copyFile 复制 .env 进 standalone(outputFileTracingExcludes 管不到),
  # 泄漏密钥到产物目录,构建后必须删除
  rm -f .next/standalone/.env
  echo "ASSETS+ENGINE_OK"
}

if [ "$(id -un)" = "chatppt" ]; then
  do_build
else
  # 以 root 触发时,构建必须落到 chatppt 用户(与运行时文件属主一致)
  su chatppt -c "bash $REPO/scripts/build-linux.sh"
fi
