#!/usr/bin/env python3
"""Local topology editor and Docker Compose project generator."""

from __future__ import annotations

import io
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
KINDS = {"client", "router", "server"}
ID_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,39}$")
MAC_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")


class TopologyError(ValueError):
    pass


def yaml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


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
        if not isinstance(gui, bool) or (kind == "router" and gui):
            raise TopologyError(f"节点 {node_id} 的 GUI 配置无效")
        node = {"id": node_id, "type": kind, "name": name.strip(), "gui": gui}
        node_by_id[node_id] = node
        clean_nodes.append(node)

    clean_links = []
    link_ids = set()
    seen_pairs = set()
    used_ips = set()
    used_macs = set()
    networks: list[ipaddress.IPv4Network] = []
    degree = {node_id: 0 for node_id in node_by_id}
    for raw in links:
        if not isinstance(raw, dict):
            raise TopologyError("连线格式错误")
        link_id, source, target = raw.get("id"), raw.get("source"), raw.get("target")
        if not isinstance(link_id, str) or not ID_PATTERN.fullmatch(link_id) or link_id in link_ids:
            raise TopologyError("连线 ID 无效或重复")
        if source not in node_by_id or target not in node_by_id or source == target:
            raise TopologyError(f"连线 {link_id} 的端点无效")
        pair = frozenset((source, target))
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
        if any(network.overlaps(other) for other in networks):
            raise TopologyError(f"连线 {link_id} 的网段与其他连线重叠")
        networks.append(network)
        clean = {"id": link_id, "source": source, "target": target, "subnet": str(network)}
        for side in ("source", "target"):
            try:
                address = ipaddress.ip_address(raw.get(side + "Ip", ""))
            except (ValueError, TypeError):
                raise TopologyError(f"连线 {link_id} 的 {side} IP 无效") from None
            if (not isinstance(address, ipaddress.IPv4Address) or address not in network
                    or address == network.network_address or address == network.broadcast_address
                    or int(address) == int(network.network_address) + 1):
                raise TopologyError(f"连线 {link_id} 的 {side} IP 不在可用网段内")
            if address in used_ips:
                raise TopologyError(f"IP 地址重复：{address}")
            used_ips.add(address)
            mac = raw.get(side + "Mac", "")
            if not isinstance(mac, str) or not MAC_PATTERN.fullmatch(mac):
                raise TopologyError(f"连线 {link_id} 的 {side} MAC 无效")
            mac = mac.lower()
            first_octet = int(mac[:2], 16)
            if first_octet & 1:
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
        if node["type"] != "router" and degree[node["id"]] > 1:
            raise TopologyError(f"客户端或服务器「{node['name']}」只能连接一条线；请用路由器分支")
    return clean_nodes, clean_links


def route_commands(nodes: list[dict], links: list[dict]) -> tuple[dict[str, list[str]], list[str]]:
    """Find the first router hop to each remote link subnet."""
    kinds = {node["id"]: node["type"] for node in nodes}
    attachments: dict[str, list[tuple[dict, str, str]]] = {node["id"]: [] for node in nodes}
    for link in links:
        attachments[link["source"]].append((link, "source", link["target"]))
        attachments[link["target"]].append((link, "target", link["source"]))

    commands: dict[str, list[str]] = {}
    warnings = []
    for node in nodes:
        source = node["id"]
        direct = {link["id"] for link, _, _ in attachments[source]}
        # Search only router transit nodes. The stored first hop is the router IP
        # on a link directly attached to the source container.
        queue = deque()
        seen = {source}
        for link, side, neighbor in attachments[source]:
            if kinds[neighbor] == "router" and neighbor not in seen:
                seen.add(neighbor)
                queue.append((neighbor, link["targetIp" if side == "source" else "sourceIp"]))
        reachable: dict[str, str] = {}
        while queue:
            router, first_hop = queue.popleft()
            for link, side, neighbor in attachments[router]:
                if link["id"] not in direct:
                    reachable.setdefault(link["id"], first_hop)
                if kinds[neighbor] == "router" and neighbor not in seen:
                    seen.add(neighbor)
                    queue.append((neighbor, first_hop))
        commands[source] = []
        for link in links:
            if link["id"] in direct:
                continue
            hop = reachable.get(link["id"])
            if hop:
                commands[source].append(f"ip route replace {link['subnet']} via {hop}")
            else:
                warnings.append(f"「{node['name']}」无法通过路由器到达 {link['subnet']}")
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
    base = "python:3.12-alpine" if kind == "server" else "alpine:3.21"
    return (f"FROM {base}\n"
            "RUN apk add --no-cache iproute2 iputils curl\n"
            "WORKDIR /workspace\n"
            f"LABEL topology.role={kind}\n")


def build_files(data: object) -> tuple[dict[str, str], list[str]]:
    nodes, links = normalize(data)
    if any(node["type"] == "router" for node in nodes) and not OPENWRT_ARCHIVE.is_file():
        raise TopologyError("缺少 OpenWrt rootfs，请将归档放入 assets 目录")
    commands, warnings = route_commands(nodes, links)
    attachments = {node["id"]: [] for node in nodes}
    for link in links:
        attachments[link["source"]].append((link, "source"))
        attachments[link["target"]].append((link, "target"))
    lines = ["name: topology-lab", "services:"]
    files = {}
    gui_ports = {}
    next_gui_port = 6901
    for node in nodes:
        node_id, kind, gui = node["id"], node["type"], node["gui"]
        files[f"dockerfiles/{node_id}.Dockerfile"] = dockerfile(kind, gui)
        lines.extend([
            f"  {node_id}:",
            "    build:",
            "      context: .",
            f"      dockerfile: dockerfiles/{node_id}.Dockerfile",
            f"    container_name: topology-{node_id}",
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
        startup = commands[node_id]
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
        for link, side in attachments[node_id]:
            lines.extend([
                f"      net_{link['id']}:",
                f"        ipv4_address: {link[side + 'Ip']}",
                f"        mac_address: {link[side + 'Mac']}",
            ])
    lines.append("networks:")
    for link in links:
        lines.extend([
            f"  net_{link['id']}:",
            "    driver: bridge",
            "    ipam:",
            "      config:",
            f"        - subnet: {link['subnet']}",
        ])
    files["compose.yaml"] = "\n".join(lines) + "\n"
    if gui_ports:
        files[".env"] = "VNC_PW=" + secrets.token_urlsafe(16) + "\n"
    lines = ["# Generated topology", "", "Run `docker compose up --build -d` in this directory.", "Use `docker compose ps` to inspect containers and `docker compose down` to stop them.", "", "## Nodes", ""]
    for node in nodes:
        suffix = "，GUI" if node["gui"] else ""
        lines.append(f"- `{node['id']}`: {node['name']} ({node['type']}{suffix})")
    lines.extend(["", "## Links", ""])
    for link in links:
        lines.append(f"- `{link['source']}` ↔ `{link['target']}`: `{link['subnet']}`; {link['sourceIp']} / {link['targetIp']}")
    if gui_ports:
        lines.extend(["", "## GUI access", "", "Open the following local HTTPS URLs after starting Compose. The desktop password is `VNC_PW` in `.env`.", ""])
        lines.extend(f"- `{node_id}`: https://localhost:{port}" for node_id, port in gui_ports.items())
        lines.extend(["", "GUI containers use Kasm's standalone desktop image and need Docker Compose with `post_start` support (v2.30+).", "The GUI server also starts an HTTP service on container port 8000."])
    if any(node["type"] == "router" for node in nodes):
        lines.extend(["", "## Router image", "", "Router Dockerfiles unpack the bundled OpenWrt ARM64 rootfs. Run on ARM64 or a Docker host with ARM64 emulation."])
    if warnings:
        lines.extend(["", "## Connectivity notes", ""])
        lines.extend(f"- {warning}" for warning in warnings)
    files["README.md"] = "\n".join(lines) + "\n"
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
        if self.path not in ("/api/preview", "/api/download"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1_000_000:
                raise TopologyError("请求内容过大或为空")
            data = json.loads(self.rfile.read(length))
            files, warnings = build_files(data)
            has_router = any(node["type"] == "router" for node in normalize(data)[0])
            if self.path == "/api/preview":
                assets = ([{"path": OPENWRT_BUNDLE_PATH, "size": OPENWRT_ARCHIVE.stat().st_size}]
                          if has_router else [])
                body = json.dumps({"files": files, "assets": assets, "warnings": warnings}, ensure_ascii=False).encode()
                self.send_bytes(200, body, "application/json; charset=utf-8")
            else:
                self.send_bytes(200, make_archive(files, has_router), "application/zip", "topology-lab.zip")
        except (TopologyError, json.JSONDecodeError) as exc:
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
