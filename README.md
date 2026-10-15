# 拓扑工坊

  拓扑工坊是一个基于浏览器的 Docker 网络实验拓扑编辑器。支持创建**客户端、服务器、路由器和交换机**，通过连线配置网段、接口 IPv4 和 MAC 地址，并生成可运行的 Docker Compose 项目。画布直接显示节点的 IP 信息：客户端/服务器显示接口地址，路由器显示各接口地址，交换机显示所属网段（交换机本身不分配 IP）。

  可使用“刷新预览”查看生成文件，使用“下载项目 ZIP”导出，也可点击**“选择文件夹并自动保存”**关联本机目录。此后修改拓扑或 Compose 项目名，会自动更新该目录中的 `compose.yaml`、Dockerfile 和相关资源；可按需启用自动构建和启动。编辑器会在浏览器中自动恢复当前草稿，也可以用“保存拓扑”导出保留节点位置、GUI 选项和画布视角的 JSON 文件，再用“打开拓扑”继续编辑。

  ## 运行编辑器

  需要 Python 3.10 或更新版本，无须额外安装 Python 依赖。

  ```
  python3 app.py
  ```

  打开 http://127.0.0.1:8080。

  也可使用 Docker 运行编辑器：

  ```
  docker compose up --build -d
  ```

  打开 http://localhost:8080。Docker 运行模式下，文件夹由浏览器直接写入本机；自动执行 Compose 仅在 macOS 上直接运行 `python3 app.py` 时可用。

  ## 保存与打开拓扑

  点击**“保存拓扑”**会打开系统保存对话框，并导出一个可重新打开的 JSON 文件。该文件保存原始画布数据，因此尚未连线的草稿也能保存；它与 Docker 项目内用于记录生成结果的 `topology.json` 用途不同。

  点击**“打开拓扑”**选择之前保存的 JSON。文件只有在格式、版本、节点 ID 和连线端点校验通过后才会替换当前画布。浏览器不支持系统文件选择 API 时，保存会退化为普通 JSON 下载，打开会使用网页文件选择框。

  ## 关联文件夹并自动保存（推荐）

  在网页中调整节点和连线，然后点击**“选择文件夹并自动保存”**。选定目录后，当前拓扑对应的 `compose.yaml`、`.env`、各节点 Dockerfile 和脚本会写入该目录，使用路由器时也会写入 OpenWrt rootfs。之后的有效修改会自动同步，无需再选文件夹或输入路径。可随时点击“更换文件夹”或“停止同步”。

  目录中存在同名文件时，首次关联会列出待覆盖文件并要求确认；关联后再次修改会自动覆盖生成文件。不会主动清理其他文件。因此删除节点后，旧 Dockerfile 可能仍留在磁盘上，但不再被新 `compose.yaml` 引用。需要保留的手工修改应放在其他文件中。

  在 macOS 上直接运行 Python 编辑器时，使用系统文件夹对话框，服务器能够定位所选目录，因此可以启用“修改后自动 build 并启动”。此选项会在同步后依次执行 `docker compose build` 和 `docker compose up -d --remove-orphans`；当已由本次关联启动的项目的 Compose 配置发生变化时，还会先停止旧项目以重建网络。如果同一文件夹中有其他项目名的容器仍在运行，页面会先提示确认替换，避免网段冲突和意外删除容器内修改。Docker 命令失败会显示在页面状态栏。

  在 Docker 容器内运行编辑器时，使用浏览器的文件夹选择器直接写入本机目录，浏览器不会提供真实路径给编辑器容器，因此不能自动执行 Docker Compose。此模式需要 Chrome 或 Edge 的 File System Access API，以及 `http://127.0.0.1:8080` 或 `http://localhost:8080` 这样的安全上下文。

  “Compose 项目名”可直接修改，允许小写字母、数字、`-`、`_`，且须以小写字母或数字开头，最多 63 个字符。名称改变后，生成的 `compose.yaml` 第一行会随之更新。

  生成完成后，在目标目录重建容器：

  ```
  cd "$HOME/Documents/Cybersecurity-lab/lab3"
  docker compose down
  docker compose up -d --build
  docker compose ps
  ```

  `driver_opts` 等网络配置不能原地修改，因此更新已有实验目录后需要先执行 `docker compose down`，再重新启动，让 Docker 重建网络。

  每个保存的拓扑都会持有独立的 Compose 项目标识，生成到不同目录的实验不会因为默认项目名相同而停止或替换彼此的容器。

  如需确保完全重新构建镜像，可运行：

  ```
  docker compose build --no-cache
  docker compose up -d --force-recreate
  ```

  > 自动构建启动默认关闭；启用前请确认 Docker Desktop 正在运行。自动模式会重建镜像，并在 Compose 配置改变时重建已由本次关联启动的容器与网络。

  ## 下载 ZIP 与运行生成的拓扑

  “下载项目 ZIP”功能仍然保留，适合将实验分享给其他机器。解压 `topology-lab.zip` 后，在解压目录运行：

  ```
  docker compose up -d --build
  docker compose ps
  # 实验结束后
  docker compose down
  ```

  在实际测试中，请使用前端所设的节点 IP，例如：

  ```
  docker exec -it client1 bash
  ping -c 3 192.168.2.11
  curl http://192.168.2.11
  ```

  以上节点名和 IP 只是示例，应按当前拓扑修改。服务器默认同时运行 Apache HTTP Server、OpenSSH、Telnet 和 vsftpd：HTTP 使用 80 端口，SSH 使用 22 端口，Telnet 使用 23 端口，FTP 使用 21 端口及被动端口 30000–30009。网站目录为 `/var/www/html`。

  ## 服务器 HTTP、SSH、Telnet 与 FTP

  新建服务器节点后，属性面板会显示服务器 IP、用户名 `lab` 和随机密码，并可一键复制。该密码随拓扑保存，并写入生成项目的 `.env` 中作为 `SERVER_PASSWORD`。所有服务器节点共用这组实验账户信息。

  拓扑启动后，可从能够到达该服务器 IP 的节点连接：

  ```
  ssh lab@192.168.2.11
  telnet 192.168.2.11 23
  ftp 192.168.2.11
  curl http://192.168.2.11/
  ```

  FTP 支持本地用户读写，默认目录是 `/home/lab`，被动模式使用容器内部的 30000–30009 端口。服务仅通过拓扑网络地址访问，生成器不会把 SSH、FTP 或 HTTP 端口发布到宿主机。

  ## 容器名称与交互式 Bash

  生成的**容器名称**优先使用拓扑画布上的节点名称，例如节点名 `attacker`、`client1`、`server`，即可直接：

  ```
  docker exec -it attacker bash
  docker exec -it client1 bash
  ```

  Docker 容器名称不允许任意字符：含空格的名称会替换非法字符，无法转换成有效 ASCII 名称的节点会回退至节点 ID。转换后如有重名，生成器会报错；原始画布名称会保留在 Docker label 中。容器 hostname 对符合 DNS 主机名规则的节点名称使用原名，否则回退至节点 ID。因此建议为需要终端操作的设备使用不重复的英文、数字或连字符名称。

  非 GUI 客户端和服务器基于 Ubuntu 24.04，预装 `bash`、命令补全和常见 Linux/网络工具（如 `ip`、`ping`、`curl`、`ssh`、`telnet`、`ftp`、`tcpdump`、`vim`、`traceroute` 等），默认工作目录为 `/root`，交互式 Bash 提示符采用 `root@hostname:~#` 风格。它们仍是容器，而不是拥有独立内核的完整虚拟机。

  **OpenWrt 路由器除外**：路由器保留 rootfs 自带的 Shell，通常应使用 `docker exec -it <路由器容器名> sh`。

  ## 网络模型

  - **交换机共享网段：**接到同一交换机的客户端、服务器和路由器接口处于同一个 Docker bridge 二层网络；交换机之间直接相连时，其二层域合并为同一个 bridge。交换机是逻辑节点，**不单独创建交换机容器**，也不分配三层 IP。
  - **直接连接：**未通过交换机的旧式设备直连链路，仍可各自对应独立 Docker bridge 网络；客户端和服务器最多接入一个网络，路由器可以接入多个网络。
  - **IP 与网关：**在每个 bridge 子网中，Docker 网关会占用首个可用主机地址（如 `192.168.2.1`），节点需使用其余可用地址。同网段设备可以直接通信；不同网段间需要路由。
  - **静态路由：**生成器为需要的设备配置非直连网段的静态路由，路由器启用 IPv4 转发。只有可通过路由器到达的网段才会生成有效路由；不可达情况会在预览和生成项目的 README 中提示。
  - **关闭 IP 伪装：**所有生成的 Docker bridge 网络都会设置 `com.docker.network.bridge.enable_ip_masquerade: "false"`。容器流量离开 bridge 时保留原始源 IP；如需访问外部网络，外部设备必须具备返回该实验网段的路由。
  - **配置校验：**生成时会检查 IP、MAC、网段冲突及节点连接数等问题。

  ## 路由器流量镜像

  选中路由器，在属性面板启用“流量镜像”，依次选择通信节点 A、通信节点 B 和镜像接收节点。三个节点可以经交换机连接，但都必须与这台路由器处于直接相连的网段；通信两端应在不同网段，且各自网段只连接这台路由器，以确保流量经过它。接收节点必须是客户端或服务器。

  生成器会在 OpenWrt 路由器中安装 nftables 规则，复制 A ↔ B 两个方向的 IPv4 报文到接收节点，同时关闭接收节点的 IP 转发，避免副本被再次路由。接收端使用 `tcpdump -ni any` 查看报文；镜像副本保留原始 IP 头，不会交给接收端普通应用处理。例如：

  ```
  docker exec -it <接收节点容器名> tcpdump -ni any 'host <A的IP> and host <B的IP>'
  ```

  修改镜像设置后，重新构建并启动生成项目，新的规则才会生效。

  ## OpenWrt 路由器

  路由器使用项目提供的 OpenWrt ARM64 rootfs。需将归档放在编辑器项目中的：

  ```
  assets/openwrt-armsr-armv8-rootfs.tar.gz
  ```

  生成的路由器 Dockerfile 以 `FROM scratch` 为基础并指定 `linux/arm64`；需在 ARM64 宿主机或支持 ARM64 模拟的 Docker 环境运行。随项目使用的 OpenWrt SNAPSHOT rootfs 只建议用于隔离的本地实验网络，**不要把其管理服务直接暴露在公网**。

  ## GUI 桌面节点

  客户端和服务器可在节点属性中启用 GUI；此时使用 `kasmweb/ubuntu-focal-desktop:1.16.0`。GUI 镜像会安装 `ping`、`ip`、`curl`、`wget`、`ssh`、`telnet`、`ftp`、`traceroute`、`tcpdump`、`nmap`、`vim` 等常用工具。启用后，属性面板会立即显示访问地址、用户名 `kasm_user` 和随机生成的密码，并可一键复制。该密码会保存在拓扑中并同步写入生成项目的 `.env`，确保页面提示与实际容器一致。网页登录名是 `kasm_user`，桌面内的 Linux 账户是 `kasm-user`；在桌面终端执行 `sudo -i` 即可免密进入容器内 root。访问 `https://localhost:<端口>`；此功能要求 Docker Compose v2.30+ 支持 `post_start`。GUI 服务器同样运行 Apache、OpenSSH、Telnet 和 vsftpd。

  ## 安全与注意事项

  本项目用于本地、隔离的网络实验。生成的客户端、服务器和路由器容器均设置 `privileged: true`，可以在容器内修改网络、服务和系统配置；交换机是 Docker bridge，不创建容器。该模式会授予容器完整 capabilities 和宿主设备访问能力，请勿直接用于生产环境。只在运行中修改的内容会在容器重建后丢失，需要长期保留的改动应写入 Dockerfile 或挂载卷。每次修改生成器代码后，需要重启 `python3 app.py`；每次更新实验目录中的 Dockerfile 后，需要重新构建相关镜像或启用页面上的自动构建。
