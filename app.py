#!/usr/bin/env python3
"""Local topology editor and Docker Compose project generator."""

from __future__ import annotations

import io
import os
import tempfile
import shutil
import ipaddress
import json
import re
import secrets
import zipfile
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
OPENWRT_ARCHIVE = ROOT / "assets" / "openwrt-armsr-armv8-rootfs.tar.gz"
OPENWRT_BUNDLE_PATH = "assets/openwrt-armsr-armv8-rootfs.tar.gz"
GUI_IMAGE = "kasmweb/ubuntu-focal-desktop:1.16.0"
KINDS = {"client", "router", "server", "switch"}
ID_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,39}$")
MAC_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
HOSTNAME_PATTERN = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")


class TopologyError(ValueError):
    pass


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def node_hostname(node: dict) -> str:
    """Use the visible node name as hostname when DNS-safe; otherwise its stable ID."""
    name = node["name"].strip()
    return name if HOSTNAME_PATTERN.fullmatch(name) else node["id"].replace("_", "-")


def node_container_name(node: dict) -> str:
    """Derive a Docker-safe container name from the visible node name."""
    name = node["name"].strip()
    if not name.isascii():
        return node["id"].replace("_", "-")
    # Docker names allow ASCII letters, numbers, underscores, periods and hyphens.
    name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("_.-")
    if not name or not name[0].isalnum():
        return node["id"].replace("_", "-")
    return name[:128].rstrip("_.-")


def topology_segments(nodes: list[dict], links: list[dict]) -> list[dict]:
    """Map logical switches (including switch-to-switch trunks) to L2 bridges.

    Physical containers never get an interface for a switch: the container's
    endpoint attaches straight to the Docker bridge for that switch component.
    Legacy physical-to-physical links remain independent bridge networks.
    """
    kinds = {node["id"]: node["type"] for node in nodes}
    parent = {node["id"]: node["id"] for node in nodes if node["type"] == "switch"}

    def root(node_id: str) -> str:
        while parent[node_id] != node_id:
            parent[node_id] = parent[parent[node_id]]
            node_id = parent[node_id]
        return node_id

    for link in links:
        source, target = link["source"], link["target"]
        if kinds[source] == kinds[target] == "switch":
            a, b = root(source), root(target)
            if a != b:
                parent[max(a, b)] = min(a, b)

    segments = {}
    for link in links:
        source, target = link["source"], link["target"]
        switches = [x for x in (source, target) if kinds[x] == "switch"]
        key = "sw_" + root(switches[0]) if switches else "link_" + link["id"]
        segment = segments.setdefault(key, {"key": key, "links": [], "subnet": link["subnet"], "members": {}})
        if segment["subnet"] != link["subnet"]:
            raise TopologyError(f"同一交换机网络的网段不一致：{segment['subnet']} 与 {link['subnet']}")
        segment["links"].append(link)
        for side in ("source", "target"):
            member = link[side]
            if kinds[member] == "switch":
                continue
            if member in segment["members"]:
                raise TopologyError(f"节点 {member} 重复连接同一个交换机网段，请只保留一个端口")
            segment["members"][member] = {"ip": link[side + "Ip"], "mac": link[side + "Mac"]}
    return list(segments.values())


def normalize(data: object) -> tuple[list[dict], list[dict]]:
    if not isinstance(data, dict):
        raise TopologyError("拓扑数据格式错误")
    nodes, links = data.get("nodes"), data.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise TopologyError("nodes 和 links 必须是数组")
    if not nodes or len(nodes) > 80 or len(links) > 160:
        raise TopologyError("请添加 1–80 个节点，最多支持 160 条连线")

    node_by_id: dict[str, dict] = {}
    clean_nodes = []
    for raw in nodes:
        if not isinstance(raw, dict):
            raise TopologyError("节点格式错误")
        node_id, kind, name = raw.get("id"), raw.get("type"), raw.get("name")
        if not isinstance(node_id, str) or not ID_PATTERN.fullmatch(node_id):
            raise TopologyError("节点 ID 只能包含字母、数字、下划线和连字符")
        if node_id in node_by_id:
            raise TopologyError(f"节点 ID 重复：{node_id}")
        if kind not in KINDS or not isinstance(name, str) or not name.strip() or len(name) > 60:
            raise TopologyError(f"节点 {node_id} 的类型或名称无效")
        gui = raw.get("gui", False)
        if not isinstance(gui, bool) or (kind in ("router", "switch") and gui):
            raise TopologyError(f"节点 {node_id} 的 GUI 配置无效")
        node = {"id": node_id, "type": kind, "name": name.strip(), "gui": gui}
        node_by_id[node_id] = node
        clean_nodes.append(node)

    clean_links = []
    link_ids, seen_pairs, used_ips, used_macs = set(), set(), set(), set()
    degree = {node_id: 0 for node_id in node_by_id}
    for raw in links:
        if not isinstance(raw, dict):
            raise TopologyError("连线格式错误")
        link_id, source, target = raw.get("id"), raw.get("source"), raw.get("target")
        if not isinstance(link_id, str) or not ID_PATTERN.fullmatch(link_id) or link_id in link_ids:
            raise TopologyError("连线 ID 无效或重复")
        if source not in node_by_id or target not in node_by_id or source == target:
            raise TopologyError(f"连线 {link_id} 的端点无效")
        pair = tuple(sorted((source, target)))
        if pair in seen_pairs:
            raise TopologyError(f"{source} 与 {target} 已有连线")
        seen_pairs.add(pair)
        link_ids.add(link_id)
        try:
            network = ipaddress.ip_network(raw.get("subnet", ""), strict=True)
        except (ValueError, TypeError):
            raise TopologyError(f"连线 {link_id} 的网段无效，请输入例如 10.200.1.0/24") from None
        if not isinstance(network, ipaddress.IPv4Network) or network.prefixlen > 29:
            raise TopologyError(f"连线 {link_id} 需要 /29 或更大的 IPv4 网段，为 Docker 网关预留地址")
        clean = {"id": link_id, "source": source, "target": target, "subnet": str(network)}
        for side in ("source", "target"):
            if node_by_id[raw[side]]["type"] == "switch":
                # Backwards-compatible payload: ignore address fields on the switch side.
                clean[side + "Ip"] = ""
                clean[side + "Mac"] = ""
                continue
            try:
                address = ipaddress.ip_address(raw.get(side + "Ip", ""))
            except (ValueError, TypeError):
                raise TopologyError(f"连线 {link_id} 的 {side} IP 无效") from None
            if (not isinstance(address, ipaddress.IPv4Address) or address not in network
                    or address == network.network_address or address == network.broadcast_address
                    or int(address) == int(network.network_address) + 1):
                raise TopologyError(f"连线 {link_id} 的 {side} IP 不在可用网段内（首个主机地址留给 Docker 网关）")
            if address in used_ips:
                raise TopologyError(f"IP 地址重复：{address}")
            used_ips.add(address)
            mac = raw.get(side + "Mac", "")
            if not isinstance(mac, str) or not MAC_PATTERN.fullmatch(mac):
                raise TopologyError(f"连线 {link_id} 的 {side} MAC 无效")
            mac = mac.lower()
            if int(mac[:2], 16) & 1:
                raise TopologyError(f"MAC 地址不能是组播地址：{mac}")
            if mac in used_macs:
                raise TopologyError(f"MAC 地址重复：{mac}")
            used_macs.add(mac)
            clean[side + "Ip"] = str(address)
            clean[side + "Mac"] = mac
        degree[source] += 1
        degree[target] += 1
        clean_links.append(clean)

    for node in clean_nodes:
        if degree[node["id"]] == 0:
            raise TopologyError(f"节点「{node['name']}」尚未连接，请先添加连线")
        if node["type"] in ("client", "server") and degree[node["id"]] > 1:
            raise TopologyError(f"客户端或服务器「{node['name']}」只能连接一条线；请连接到交换机扩展网段")

    segments = topology_segments(clean_nodes, clean_links)
    used_networks = []
    for segment in segments:
        network = ipaddress.ip_network(segment["subnet"])
        if any(network.overlaps(other) for other in used_networks):
            raise TopologyError(f"不同二层网段不能重叠：{segment['subnet']}")
        used_networks.append(network)
        if not segment["members"]:
            raise TopologyError(f"交换机网段 {segment['subnet']} 没有连接任何主机或路由器")
    return clean_nodes, clean_links


def route_commands(nodes: list[dict], links: list[dict]) -> tuple[dict[str, list[str]], list[str]]:
    """Use router-only transit over shared L2 segments for static routes."""
    kinds = {node["id"]: node["type"] for node in nodes}
    segments = topology_segments(nodes, links)
    members_to_segments = {node["id"]: [] for node in nodes if node["type"] != "switch"}
    for segment in segments:
        for member in segment["members"]:
            members_to_segments[member].append(segment)

    commands: dict[str, list[str]] = {}
    warnings = []
    for node in nodes:
        source = node["id"]
        if node["type"] == "switch":
            continue
        direct = {seg["key"] for seg in members_to_segments[source]}
        queue = deque()
        seen = {source}
        for seg in members_to_segments[source]:
            for neighbor, interface in seg["members"].items():
                if kinds[neighbor] == "router" and neighbor not in seen:
                    seen.add(neighbor)
                    queue.append((neighbor, interface["ip"]))
        reachable: dict[str, str] = {}
        while queue:
            router, first_hop = queue.popleft()
            for seg in members_to_segments[router]:
                if seg["key"] not in direct:
                    reachable.setdefault(seg["key"], first_hop)
                for neighbor in seg["members"]:
                    if kinds[neighbor] == "router" and neighbor not in seen:
                        seen.add(neighbor)
                        queue.append((neighbor, first_hop))
        commands[source] = []
        for seg in segments:
            if seg["key"] in direct:
                continue
            hop = reachable.get(seg["key"])
            if hop:
                commands[source].append(f"ip route replace {seg['subnet']} via {hop}")
            else:
                warnings.append(f"「{node['name']}」无法通过路由器到达 {seg['subnet']}")
    return commands, warnings


def dockerfile(kind: str, gui: bool = False) -> str:
    if kind == "router":
        return ("FROM scratch\n"
                f"ADD {OPENWRT_BUNDLE_PATH} /\n"
                "ENV PATH=/usr/sbin:/usr/bin:/sbin:/bin\n"
                "LABEL topology.role=router\n")
    if gui:
        return (f"FROM {GUI_IMAGE}\n"
                f"LABEL topology.role={kind}\n")
    return ("FROM ubuntu:24.04\n"
            "ENV DEBIAN_FRONTEND=noninteractive\n"
            "RUN apt-get update && apt-get install -y --no-install-recommends "
            "bash bash-completion ca-certificates coreutils findutils grep sed less nano vim "
            "procps util-linux iproute2 iputils-ping dnsutils traceroute "
            "curl wget tcpdump net-tools hping3 nmap python3 python3-scapy "
            "&& rm -rf /var/lib/apt/lists/*\n"
            "ENV SHELL=/bin/bash HOME=/root TERM=xterm-256color\n"
            "WORKDIR /root\n"
            "RUN printf '%s\\n' 'export PS1=\"\\u@\\h:\\w\\$ \"' > /root/.bashrc\n"
            "CMD [\"/bin/bash\"]\n"
            f"LABEL topology.role={kind}\n")


def build_files(data: object) -> tuple[dict[str, str], list[str]]:
    nodes, links = normalize(data)
    has_router = any(node["type"] == "router" for node in nodes)
    if has_router and not OPENWRT_ARCHIVE.is_file():
        raise TopologyError("缺少 OpenWrt rootfs，请将归档放入 assets/openwrt-armsr-armv8-rootfs.tar.gz")
    container_names = {}
    for node in nodes:
        if node["type"] == "switch":
            continue
        container_name = node_container_name(node)
        key = container_name.lower()
        if key in container_names:
            raise TopologyError(f"容器名称重复：{node['name']} 与 {container_names[key]} 都映射为 {container_name}，请修改节点名称")
        container_names[key] = node["name"]
    segments = topology_segments(nodes, links)
    commands, warnings = route_commands(nodes, links)
    attachments = {node["id"]: [] for node in nodes if node["type"] != "switch"}
    for segment in segments:
        for member, interface in segment["members"].items():
            attachments[member].append((segment["key"], interface))
    lines = ["name: topology-lab", "services:"]
    files = {}
    gui_ports = {}
    next_gui_port = 6901
    for node in nodes:
        node_id, kind, gui = node["id"], node["type"], node["gui"]
        if kind == "switch":
            continue  # One bridge per L2 domain; no pretend switch container.
        files[f"dockerfiles/{node_id}.Dockerfile"] = dockerfile(kind, gui)
        lines.extend([
            f"  {node_id}:",
            "    build:",
            "      context: .",
            f"      dockerfile: dockerfiles/{node_id}.Dockerfile",
            f"    container_name: {yaml_string(node_container_name(node))}",
            f"    hostname: {yaml_string(node_hostname(node))}",
            "    labels:",
            f"      topology.name: {yaml_string(node['name'])}",
            f"      topology.role: {yaml_string(kind)}",
        ])
        if kind == "router":
            lines.append("    platform: linux/arm64")
        if gui:
            gui_ports[node_id] = next_gui_port
            next_gui_port += 1
            lines.extend([
                "    shm_size: 512m",
                "    environment:",
                "      VNC_PW: ${VNC_PW}",
                "    ports:",
                f"      - \"127.0.0.1:{gui_ports[node_id]}:6901\"",
            ])
        if kind == "router" or commands[node_id]:
            lines.extend(["    cap_add:", "      - NET_ADMIN"])
        if kind == "router":
            lines.extend(["    sysctls:", "      net.ipv4.ip_forward: \"1\""])
        startup = list(commands[node_id])
        if gui:
            hook = startup + (["(nohup python3 -m http.server 8000 --bind 0.0.0.0 >/tmp/topology-http.log 2>&1 </dev/null &)"] if kind == "server" else [])
            if hook:
                lines.extend([
                    "    post_start:",
                    "      - command: [\"sh\", \"-c\", " + yaml_string(" && ".join(hook)) + "]",
                    "        user: root",
                ])
        else:
            startup += ["python3 -m http.server 8000 --bind 0.0.0.0"] if kind == "server" else ["tail -f /dev/null"]
            lines.append(f"    command: [\"sh\", \"-c\", {yaml_string(' && '.join(startup))}]")
        lines.append("    networks:")
        for key, interface in attachments[node_id]:
            lines.extend([
                f"      net_{key}:",
                f"        ipv4_address: {interface['ip']}",
                f"        mac_address: {interface['mac']}",
            ])
    lines.append("networks:")
    for segment in segments:
        lines.extend([
            f"  net_{segment['key']}:",
            "    driver: bridge",
            "    ipam:",
            "      config:",
            f"        - subnet: {segment['subnet']}",
        ])
    files["compose.yaml"] = "\n".join(lines) + "\n"
    if gui_ports:
        files[".env"] = "VNC_PW=" + secrets.token_urlsafe(16) + "\n"
    readme = ["# Generated topology", "", "Run `docker compose up --build -d` in this directory.", "Use `docker compose ps` to inspect containers and `docker compose down` to stop them.", "", "## Nodes", ""]
    for node in nodes:
        suffix = "，GUI" if node["gui"] else ""
        detail = "（Docker bridge 虚拟二层交换机，不创建容器）" if node["type"] == "switch" else ""
        readme.append(f"- `{node['id']}`: {node['name']} ({node['type']}{suffix}){detail}" + (f"; container=`{node_container_name(node)}`, hostname=`{node_hostname(node)}`" if node["type"] != "switch" else ""))
    readme.extend(["", "Client/server non-GUI images include Bash and common Linux tools; interactive Bash displays `root@hostname:~#`. Enter with `docker exec -it <container-name> bash`.", "For DNS-safe ASCII node names, the hostname matches the visible name; names containing Chinese, spaces or invalid hostname characters use the node ID as hostname. The container name uses the visible node name where Docker-safe; invalid characters are replaced by hyphens and names consisting entirely of non-ASCII characters fall back to the node ID. The original visible name is kept in the `topology.name` label.", "OpenWrt router images retain the shells supplied by their rootfs (usually `sh`).", "", "## Layer-2 networks", "", "Each switch-connected domain (including interconnected switches) maps to one Docker bridge.", "All attached physical containers share the same subnet and can communicate without a router.", "Switch ports have no IP or MAC; the bridge's first host IP is reserved for the Docker gateway.", ""])
    for segment in segments:
        participants = ", ".join(f"{node_id}={iface['ip']}" for node_id, iface in segment["members"].items())
        readme.append(f"- `net_{segment['key']}` `{segment['subnet']}`: {participants}")
    readme.extend(["", "## Links", ""])
    kinds = {node["id"]: node["type"] for node in nodes}
    for link in links:
        source_ip = link['sourceIp'] if kinds[link['source']] != 'switch' else 'switch port'
        target_ip = link['targetIp'] if kinds[link['target']] != 'switch' else 'switch port'
        readme.append(f"- `{link['source']}` ↔ `{link['target']}`: `{link['subnet']}`; {source_ip} / {target_ip}")
    if gui_ports:
        readme.extend(["", "## GUI access", "", "Open the following local HTTPS URLs after starting Compose. The desktop password is `VNC_PW` in `.env`.", ""])
        readme.extend(f"- `{node_id}`: https://localhost:{port}" for node_id, port in gui_ports.items())
        readme.extend(["", "GUI containers use Kasm's standalone desktop image and need Docker Compose with `post_start` support (v2.30+).", "The GUI server also starts an HTTP service on container port 8000."])
    if has_router:
        readme.extend(["", "## Router image", "", "Router Dockerfiles unpack the bundled OpenWrt ARM64 rootfs. Run on ARM64 or a Docker host with ARM64 emulation."])
    if warnings:
        readme.extend(["", "## Connectivity notes", ""])
        readme.extend(f"- {warning}" for warning in warnings)
    files["README.md"] = "\n".join(readme) + "\n"
    files["topology.json"] = json.dumps({"nodes": nodes, "links": links}, ensure_ascii=False, indent=2) + "\n"
    return files, warnings


def make_archive(files: dict[str, str], include_openwrt: bool) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        if include_openwrt:
            archive.write(OPENWRT_ARCHIVE, OPENWRT_BUNDLE_PATH)
    return buffer.getvalue()


def output_directory() -> Path:
    """Writable destination is controlled by the local operator, never by a browser path."""
    return Path(os.environ.get("TOPOLOGY_OUTPUT_DIR", str(ROOT / "generated-lab"))).expanduser().resolve()


def selected_output_directory(directory: str | None) -> Path:
    if directory is None or not directory.strip():
        return output_directory()
    if not isinstance(directory, str) or len(directory) > 2048 or "\x00" in directory:
        raise TopologyError("生成目录格式错误")
    path = Path(os.path.expandvars(directory.strip())).expanduser()
    if not path.is_absolute():
        raise TopologyError("请输入绝对路径，例如 ~/Documents/Cybersecurity-lab/lab3")
    # Local writes are allowed only within the current account's home directory,
    # the editor's project directory or its explicitly configured output folder.
    resolved = path.resolve()
    allowed_roots = [Path.home().resolve(), ROOT.resolve(), output_directory()]
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        raise TopologyError("目录超出允许范围：请选择当前用户主目录下的文件夹")
    if path.is_symlink():
        raise TopologyError("不允许使用符号链接作为生成目录")
    if resolved.exists() and not resolved.is_dir():
        raise TopologyError("所选路径不是目录")
    return resolved


def save_to_local(files: dict[str, str], include_openwrt: bool, confirm: bool = False, directory: str | None = None) -> dict:
    target = selected_output_directory(directory)
    contents = dict(files)
    asset_names = [OPENWRT_BUNDLE_PATH] if include_openwrt else []
    paths = list(contents) + asset_names
    for name in paths:
        relative = Path(name)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts or any(part in ("", ".") for part in relative.parts):
            raise TopologyError(f"不允许的输出文件路径：{name}")
        path = target / relative
        current = target
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise TopologyError(f"不允许覆盖符号链接：{name}")
        if path.exists() and not path.is_file():
            raise TopologyError(f"目标位置不是普通文件：{name}")
    overwritten = [name for name in paths if (target / name).is_file()]
    if overwritten and not confirm:
        return {"needsConfirmation": True, "directory": str(target), "overwritten": overwritten, "written": []}
    target.mkdir(parents=True, exist_ok=True)
    for name in paths:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Stage alongside each destination then atomically replace its contents.
        fd, temporary = tempfile.mkstemp(prefix=".topology-", dir=destination.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                if name in contents:
                    stream.write(contents[name].encode("utf-8"))
                else:
                    with OPENWRT_ARCHIVE.open("rb") as source:
                        shutil.copyfileobj(source, stream)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return {"needsConfirmation": False, "directory": str(target), "overwritten": overwritten, "written": paths}


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status: int, body: bytes, mime: str, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        names = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8")}
        if path not in names:
            self.send_error(404)
            return
        filename, mime = names[path]
        self.send_bytes(200, (STATIC / filename).read_bytes(), mime)

    def do_POST(self) -> None:
        if self.path not in ("/api/preview", "/api/download", "/api/save"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1_000_000:
                raise TopologyError("请求内容过大或为空")
            data = json.loads(self.rfile.read(length))
            confirm = False
            if self.path == "/api/save":
                if self.client_address[0] not in ("127.0.0.1", "::1"):
                    raise TopologyError("本地写入仅允许在本机运行的编辑器使用")
                if not isinstance(data, dict):
                    raise TopologyError("拓扑数据格式错误")
                confirm = data.pop("confirmOverwrite", False) is True
                selected_directory = data.pop("outputDirectory", None)
                if selected_directory is not None and not isinstance(selected_directory, str):
                    raise TopologyError("生成目录必须是字符串")
            files, warnings = build_files(data)
            has_router = any(node["type"] == "router" for node in normalize(data)[0])
            if self.path == "/api/preview":
                assets = ([{"path": OPENWRT_BUNDLE_PATH, "size": OPENWRT_ARCHIVE.stat().st_size}]
                          if has_router else [])
                body = json.dumps({"files": files, "assets": assets, "warnings": warnings}, ensure_ascii=False).encode()
                self.send_bytes(200, body, "application/json; charset=utf-8")
            elif self.path == "/api/save":
                result = save_to_local(files, has_router, confirm, selected_directory)
                self.send_bytes(200, json.dumps(result, ensure_ascii=False).encode(), "application/json; charset=utf-8")
            else:
                self.send_bytes(200, make_archive(files, has_router), "application/zip", "topology-lab.zip")
        except (TopologyError, json.JSONDecodeError, OSError) as exc:
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode()
            self.send_bytes(400, body, "application/json; charset=utf-8")


def main() -> None:
    import os
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Topology Lab: http://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
