# deploy/

生产环境的「配置与脚本」副本。之前这些东西**只存在于服务器磁盘上**，机器重装就得凭文档重拼，所以收进仓库。

| 文件 | 服务器上的对应位置 | 说明 |
| -- | -- | -- |
| `nginx/english-node.conf` | `/etc/nginx/sites-available/english-node` | 生产站点配置：HTTP 全量跳 HTTPS、www 跳裸域、`/api/` 反代 127.0.0.1:3000、`/assets/` 长缓存与 WebP 协商 |
| `scripts/gen-webp.sh` | 不需要放服务器，在构建机上跑 | 给 `dist/assets` 的图片生成 `.webp` 兄弟文件，配合 nginx 的 `map $http_accept` 使用 |

## 新机器部署时

```bash
cp deploy/nginx/english-node.conf /etc/nginx/sites-available/english-node
ln -s /etc/nginx/sites-available/english-node /etc/nginx/sites-enabled/
nginx -t && systemctl restart nginx
```

⚠️ 配置里写死了域名 `example.com` 与证书路径 `/etc/letsencrypt/live/example.com/`，换域名或换机器要一起改，否则 `nginx -t` 会因证书文件不存在而失败。

## 每次发布前端之后

```bash
bash deploy/scripts/gen-webp.sh /var/www/english-app/assets
```

**这一步不能忘**：`.webp` 是构建产物的一部分，上传新 `dist` 会把它们覆盖掉。漏跑的后果不是报错，而是「悄悄退回原图」——首屏从 400KB 变回 2.9MB，只看日志完全发现不了。

更彻底的做法是把图片压缩接进前端构建（`vite-plugin-imagemin` / `vite-imagetools`），见 `md/22_前端协作清单.md` 第 79 行。
