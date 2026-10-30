#!/usr/bin/env bash
#
# 给前端构建产物里的图片生成 WebP 兄弟文件。
#
# 为什么需要它：dist/assets 里那几张「照片」是用 PNG 存的（单张 2MB），
# 首屏要下好几 MB。nginx 侧已经配好按 Accept 头协商（见 deploy/nginx/english-node.conf），
# 只要同目录存在 <原名>.webp 就会优先发它，不支持 WebP 的浏览器自动回落原图。
#
# 现状（2026-10-30 起）：前端已把生成接进自己的构建（English_vue 提交 2792896），
# 新 dist 里自带 .webp。本脚本因此降级为**兜底**——只有碰上没带 .webp 的 dist 时才需要跑。
# 已存在 .webp 时重跑也只是覆盖成同样的结果，无害。
#
# 用法：
#   bash deploy/scripts/gen-webp.sh                 # 默认处理 dist/assets
#   bash deploy/scripts/gen-webp.sh /var/www/english-app/assets
#
# 依赖：apt install webp（提供 cwebp）
#
set -euo pipefail

target="${1:-dist/assets}"
min_size="${MIN_SIZE:-102400}" # 小于 100KB 的不值得再压，收益抵不上多一份文件

if ! command -v cwebp >/dev/null 2>&1; then
  echo "缺少 cwebp，先安装：apt install -y webp" >&2
  exit 1
fi

if [ ! -d "$target" ]; then
  echo "目录不存在：$target" >&2
  exit 1
fi

# 统计用：处理前后各算一次，方便肉眼确认「确实变小了」
before=0
after=0
count=0

file_size() {
  # GNU stat 用 -c，BSD/macOS 用 -f
  stat -c%s "$1" 2>/dev/null || stat -f%z "$1"
}

while IFS= read -r -d '' src; do
  size=$(file_size "$src")
  [ "$size" -ge "$min_size" ] || continue

  # -q 82：照片类素材在这个质量下肉眼基本无差；-m 6 是最慢但也最小的压缩档，
  # 一次性构建任务值得多花几百毫秒
  cwebp -quiet -q 82 -m 6 "$src" -o "$src.webp"

  webp_size=$(file_size "$src.webp")
  before=$((before + size))
  after=$((after + webp_size))
  count=$((count + 1))

  printf '  %-40s %9d -> %9d\n' "$(basename "$src")" "$size" "$webp_size"
done < <(find "$target" -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) -print0)

echo "生成 $count 个 .webp：$before 字节 -> $after 字节"
if [ "$count" -eq 0 ]; then
  echo "（没有超过 ${min_size} 字节的图片，可能 dist 还没构建，或已经压过了）"
fi
