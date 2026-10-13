# 拓扑工坊

在浏览器里创建客户端、路由器和服务器节点，连接节点后设置每条链路的网段、两端 IPv4 和 MAC 地址。路由器自动使用随项目打包的 OpenWrt ARM64 rootfs；客户端和服务器可选 GUI，启用时使用 `kasmweb/ubuntu-focal-desktop:1.16.0`。点击“刷新预览”查看生成文件，点击“下载项目 ZIP”获取可运行的 Docker Compose 项目。

## 运行编辑器

本机运行（仅需 Python 3.10+，无需安装依赖）：

```bash
python3 app.py
```

打开 <http://127.0.0.1:8080>。也可用 Docker 运行编辑器：

```bash
docker compose up --build -d
```

打开 <http://localhost:8080>。

## 运行生成的拓扑

解压下载的 `topology-lab.zip`，在解压目录执行：

```bash
docker compose up --build -d
docker compose ps
docker compose exec client-1 ping -c 3 10.200.2.11
docker compose down
```

最后一条 `ping` 示例适用于默认拓扑。服务器节点在端口 8000 提供 Python HTTP 服务，可从客户端容器内使用 `curl http://<服务器IP>:8000` 验证。

## 网络模型

- 每条连线对应独立的 Docker bridge 网络。客户端和服务器只能接一条线；路由器可接多个网络。
- 生成器在各节点中配置通往非直连网段的静态路由；路由器启用 IPv4 转发。只有经过路由器可达的网段才会生成路由。不可达网络会在预览和生成项目的 README 中提示。
- OpenWrt rootfs 会打包进下载的 ZIP，路由器镜像用 `FROM scratch` 构建并指定 `linux/arm64`。宿主机需要 ARM64，或支持 ARM64 模拟。
- 随项目提供的 OpenWrt SNAPSHOT rootfs 仅用于隔离的本地实验网络；不要把生成的路由器管理服务直接暴露到公网。
- GUI 节点使用 Kasm 独立桌面。生成项目会为每个 GUI 节点分配本机 `6901` 起的不同端口，并在 `.env` 中生成随机桌面密码。打开 `https://localhost:端口` 访问；需要支持 `post_start` 的 Docker Compose v2.30+。GUI 服务器仍会在容器端口 8000 启动 HTTP 服务。
- 为设置静态路由，相关容器使用 `NET_ADMIN` capability。生成项目用于本地实验环境。
- MAC、IP、网段重叠、节点连接数等配置在生成时校验。
- 编辑器仅在本地浏览器 `localStorage` 保存画布。生成 API 不执行 Docker 命令。
