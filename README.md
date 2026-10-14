# 拓扑工坊

  拓扑工坊是一个基于浏览器的 Docker 网络实验拓扑编辑器。支持创建**客户端、服务器、路由器和交换机**，通过连线配置网段、接口 IPv4 和 MAC 地址，并生成可运行的 Docker Compose 项目。画布直接显示节点的 IP 信息：客户端/服务器显示接口地址，路由器显示各接口地址，交换机显示所属网段（交换机本身不分配 IP）。

  可使用“刷新预览”查看生成文件，使用“下载项目 ZIP”导出，也可点击**“选择文件夹并生成”**，通过系统文件夹选择器把 `compose.yaml`、Dockerfile 和相关资源直接写入本机目录。编辑器会在浏览器中自动恢复当前草稿，也可以用“保存拓扑”导出保留节点位置、GUI 选项和画布视角的 JSON 文件，再用“打开拓扑”继续编辑。

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

  打开 http://localhost:8080。项目目录由浏览器直接写入，因此无论编辑器使用 Python 还是 Docker 启动，系统选择器选中的都是本机文件夹。

  ## 保存与打开拓扑

  点击**“保存拓扑”**会打开系统保存对话框，并导出一个可重新打开的 JSON 文件。该文件保存原始画布数据，因此尚未连线的草稿也能保存；它与 Docker 项目内用于记录生成结果的 `topology.json` 用途不同。

  点击**“打开拓扑”**选择之前保存的 JSON。文件只有在格式、版本、节点 ID 和连线端点校验通过后才会替换当前画布。浏览器不支持系统文件选择 API 时，保存会退化为普通 JSON 下载，打开会使用网页文件选择框。

  ## 选择文件夹并生成（推荐）

  在网页中调整节点和连线，然后点击**“选择文件夹并生成”**。Chrome 或 Edge 会显示系统级文件夹选择器；选定目录后，浏览器会把当前拓扑对应的 `compose.yaml`、`.env`、各节点 Dockerfile 和脚本直接写入该目录，使用路由器时也会写入 OpenWrt rootfs。无需输入路径或设置环境变量。

  目录中存在同名文件时，页面会先列出待覆盖文件并要求确认；不会主动清理其他文件。因此删除节点后，旧 Dockerfile 可能仍留在磁盘上，但不再被新 `compose.yaml` 引用。重要的手工修改应在确认覆盖前备份。

  系统文件夹选择功能需要安全上下文和 File System Access API。`http://127.0.0.1:8080` 与 `http://localhost:8080` 可以使用；Chrome、Edge 支持该功能。不支持时按钮会自动改为下载 ZIP。

  生成完成后，在目标目录重建容器：

  ```
  cd "$HOME/Documents/Cybersecurity-lab/lab3"
  docker compose down
  docker compose up -d --build
  docker compose ps
  ```

  `driver_opts` 等网络配置不能原地修改，因此更新已有实验目录后需要先执行 `docker compose down`，再重新启动，让 Docker 重建网络。

  如需确保完全重新构建镜像，可运行：

  ```
  docker compose build --no-cache
  docker compose up -d --force-recreate
  ```

  > 编辑器只生成文件，不会自动执行 Docker 命令。浏览器只会访问你在系统对话框中明确选择的目录。

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

  以上节点名和 IP 只是示例，应按当前拓扑修改。服务器默认使用 Apache HTTP Server，在容器的 80 端口提供服务，网站目录为 `/var/www/html`。

  ## 容器名称与交互式 Bash

  生成的**容器名称**优先使用拓扑画布上的节点名称，例如节点名 `attacker`、`client1`、`server`，即可直接：

  ```
  docker exec -it attacker bash
  docker exec -it client1 bash
  ```

  Docker 容器名称不允许任意字符：含空格的名称会替换非法字符，无法转换成有效 ASCII 名称的节点会回退至节点 ID。转换后如有重名，生成器会报错；原始画布名称会保留在 Docker label 中。容器 hostname 对符合 DNS 主机名规则的节点名称使用原名，否则回退至节点 ID。因此建议为需要终端操作的设备使用不重复的英文、数字或连字符名称。

  非 GUI 客户端和服务器基于 Ubuntu 24.04，预装 `bash`、命令补全和常见 Linux/网络工具（如 `ip`、`ping`、`curl`、`tcpdump`、`vim`、`traceroute` 等），默认工作目录为 `/root`，交互式 Bash 提示符采用 `root@hostname:~#` 风格。它们仍是容器，而不是拥有独立内核的完整虚拟机。

  **OpenWrt 路由器除外**：路由器保留 rootfs 自带的 Shell，通常应使用 `docker exec -it <路由器容器名> sh`。

  ## 网络模型

  - **交换机共享网段：**接到同一交换机的客户端、服务器和路由器接口处于同一个 Docker bridge 二层网络；交换机之间直接相连时，其二层域合并为同一个 bridge。交换机是逻辑节点，**不单独创建交换机容器**，也不分配三层 IP。
  - **直接连接：**未通过交换机的旧式设备直连链路，仍可各自对应独立 Docker bridge 网络；客户端和服务器最多接入一个网络，路由器可以接入多个网络。
  - **IP 与网关：**在每个 bridge 子网中，Docker 网关会占用首个可用主机地址（如 `192.168.2.1`），节点需使用其余可用地址。同网段设备可以直接通信；不同网段间需要路由。
  - **静态路由：**生成器为需要的设备配置非直连网段的静态路由，路由器启用 IPv4 转发。只有可通过路由器到达的网段才会生成有效路由；不可达情况会在预览和生成项目的 README 中提示。
  - **关闭 IP 伪装：**所有生成的 Docker bridge 网络都会设置 `com.docker.network.bridge.enable_ip_masquerade: "false"`。容器流量离开 bridge 时保留原始源 IP；如需访问外部网络，外部设备必须具备返回该实验网段的路由。
  - **配置校验：**生成时会检查 IP、MAC、网段冲突及节点连接数等问题。

  ## OpenWrt 路由器

  路由器使用项目提供的 OpenWrt ARM64 rootfs。需将归档放在编辑器项目中的：

  ```
  assets/openwrt-armsr-armv8-rootfs.tar.gz
  ```

  生成的路由器 Dockerfile 以 `FROM scratch` 为基础并指定 `linux/arm64`；需在 ARM64 宿主机或支持 ARM64 模拟的 Docker 环境运行。随项目使用的 OpenWrt SNAPSHOT rootfs 只建议用于隔离的本地实验网络，**不要把其管理服务直接暴露在公网**。

  ## GUI 桌面节点

  客户端和服务器可在节点属性中启用 GUI；此时使用 `kasmweb/ubuntu-focal-desktop:1.16.0`。启用后，属性面板会立即显示访问地址、用户名 `kasm_user` 和随机生成的密码，并可一键复制。该密码会保存在拓扑中并同步写入生成项目的 `.env`，确保页面提示与实际容器一致。网页登录名是 `kasm_user`，桌面内的 Linux 账户是 `kasm-user`；在桌面终端执行 `sudo -i` 即可免密进入容器内 root。访问 `https://localhost:<端口>`；此功能要求 Docker Compose v2.30+ 支持 `post_start`。GUI 服务器同样使用 Apache，并在容器内 80 端口提供 HTTP 服务。

  ## 安全与注意事项

  本项目用于本地、隔离的网络实验。生成的客户端、服务器和路由器容器均设置 `privileged: true`，可以在容器内修改网络、服务和系统配置；交换机是 Docker bridge，不创建容器。该模式会授予容器完整 capabilities 和宿主设备访问能力，请勿直接用于生产环境。只在运行中修改的内容会在容器重建后丢失，需要长期保留的改动应写入 Dockerfile 或挂载卷。编辑器只负责生成文件，不直接启动 Docker 容器。每次修改生成器代码后，需要重启 `python3 app.py`；每次更新实验目录中的 Dockerfile 后，需要重新构建相关镜像。
