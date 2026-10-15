#!/usr/bin/env python3
"""Local topology editor and Docker Compose project generator."""

from __future__ import annotations

import hashlib
import io
import ipaddress
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
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
GUI_USERNAME = "kasm_user"
SERVER_USERNAME = "lab"
KINDS = {"client", "router", "server", "switch"}
ID_PATTERN = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,39}$")
MAC_PATTERN = re.compile(r"^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$")
HOSTNAME_PATTERN = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$")
GUI_PASSWORD_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SERVER_PASSWORD_PATTERN = GUI_PASSWORD_PATTERN
PROJECT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
LOCAL_PROJECTS: dict[str, dict] = {}
LOCAL_PROJECTS_LOCK = threading.Lock()


class TopologyError(ValueError):
    pass


class ComposeReplacementRequired(TopologyError):
    def __init__(self, projects: set[str]):
        self.projects = sorted(projects)
        super().__init__(f"发现同一文件夹中仍在使用的旧 Compose 项目：{', '.join(self.projects)}")


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
        mirror = raw.get("mirror")
        if mirror is not None:
            if (kind != "router" or not isinstance(mirror, dict)
                    or set(mirror) != {"source", "target", "destination"}
                    or any(not isinstance(mirror[field], str) for field in ("source", "target", "destination"))):
                raise TopologyError(f"节点 {node_id} 的流量镜像配置无效")
            node["mirror"] = {field: mirror[field] for field in ("source", "target", "destination")}
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
    for node in clean_nodes:
        mirror = node.get("mirror")
        if not mirror:
            continue
        endpoints = [mirror[field] for field in ("source", "target", "destination")]
        if len(set(endpoints)) != 3 or any(endpoint not in node_by_id or node_by_id[endpoint]["type"] not in ("client", "server") for endpoint in endpoints):
            raise TopologyError(f"路由器「{node['name']}」的流量镜像须选择三个不同的客户端或服务器节点")
        member_segments = {}
        for segment in segments:
            for endpoint in endpoints:
                if endpoint in segment["members"]:
                    member_segments[endpoint] = segment
        if any(node["id"] not in member_segments[endpoint]["members"] for endpoint in endpoints):
            raise TopologyError(f"流量镜像的三个节点都必须与路由器「{node['name']}」处于直接相连的网段")
        if member_segments[mirror["source"]] is member_segments[mirror["target"]]:
            raise TopologyError(f"流量镜像的通信两端必须位于路由器「{node['name']}」连接的不同网段")
        for endpoint in (mirror["source"], mirror["target"]):
            routers = [member for member in member_segments[endpoint]["members"] if node_by_id[member]["type"] == "router"]
            if routers != [node["id"]]:
                raise TopologyError(f"流量镜像的通信网段只能连接路由器「{node['name']}」，以确保流量经过它")
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
        packages = ("sudo ca-certificates procps iproute2 iputils-ping dnsutils traceroute curl wget "
                    "tcpdump net-tools netcat-openbsd hping3 nmap openssh-client inetutils-telnet inetutils-ftp "
                    "less nano vim")
        if kind == "server":
            packages += " apache2 openssh-server vsftpd busybox-static"
        install_steps = [
            "apt-get update",
            f"apt-get install -y --no-install-recommends {packages}",
            "printf '%s\\n' 'kasm-user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/kasm-user",
            "chmod 0440 /etc/sudoers.d/kasm-user",
        ]
        if kind == "server":
            install_steps.extend([
                f"(id -u {SERVER_USERNAME} >/dev/null 2>&1 || useradd -m -s /bin/bash {SERVER_USERNAME})",
                "mkdir -p /run/sshd /var/run/vsftpd/empty /etc/ssh/sshd_config.d",
                "printf '%s\\n' 'PasswordAuthentication yes' 'PermitRootLogin no' > /etc/ssh/sshd_config.d/topology.conf",
                "printf '%s\\n' 'listen=YES' 'listen_ipv6=NO' 'background=YES' 'anonymous_enable=NO' 'local_enable=YES' 'write_enable=YES' 'local_umask=022' 'chroot_local_user=YES' 'allow_writeable_chroot=YES' 'pam_service_name=vsftpd' 'secure_chroot_dir=/var/run/vsftpd/empty' 'pasv_enable=YES' 'pasv_min_port=30000' 'pasv_max_port=30009' 'seccomp_sandbox=NO' > /etc/vsftpd.conf",
                "printf '%s\\n' 'ServerName localhost' > /etc/apache2/conf-available/topology-server-name.conf",
                "a2enconf topology-server-name",
            ])
        install_steps.append("rm -rf /var/lib/apt/lists/*")
        install_command = " \\\n    && ".join(install_steps)
        expose = "EXPOSE 21 22 23 80 30000-30009\n" if kind == "server" else ""
        return (f"FROM {GUI_IMAGE}\n"
                "USER root\n"
                f"RUN {install_command}\n"
                "USER 1000\n"
                f"{expose}"
                f"LABEL topology.role={kind}\n")
    packages = ("bash bash-completion ca-certificates coreutils findutils grep sed less nano vim "
                "procps util-linux iproute2 iputils-ping dnsutils traceroute "
                "curl wget tcpdump net-tools netcat-openbsd hping3 nmap openssh-client inetutils-telnet "
                "inetutils-ftp python3 python3-scapy")
    if kind == "server":
        packages += " apache2 openssh-server vsftpd busybox-static"
    server_setup = (
        f"RUN (id -u {SERVER_USERNAME} >/dev/null 2>&1 || useradd -m -s /bin/bash {SERVER_USERNAME}) "
        "&& mkdir -p /run/sshd /var/run/vsftpd/empty /etc/ssh/sshd_config.d "
        "&& printf '%s\\n' 'PasswordAuthentication yes' 'PermitRootLogin no' > /etc/ssh/sshd_config.d/topology.conf "
        "&& printf '%s\\n' 'listen=YES' 'listen_ipv6=NO' 'background=YES' 'anonymous_enable=NO' 'local_enable=YES' 'write_enable=YES' 'local_umask=022' 'chroot_local_user=YES' 'allow_writeable_chroot=YES' 'pam_service_name=vsftpd' 'secure_chroot_dir=/var/run/vsftpd/empty' 'pasv_enable=YES' 'pasv_min_port=30000' 'pasv_max_port=30009' 'seccomp_sandbox=NO' > /etc/vsftpd.conf "
        "&& printf '%s\\n' 'ServerName localhost' > /etc/apache2/conf-available/topology-server-name.conf "
        "&& a2enconf topology-server-name\n"
        "EXPOSE 21 22 23 80 30000-30009\n" if kind == "server" else "")
    return ("FROM ubuntu:24.04\n"
            "ENV DEBIAN_FRONTEND=noninteractive\n"
            f"RUN apt-get update && apt-get install -y --no-install-recommends {packages} "
            "&& rm -rf /var/lib/apt/lists/*\n"
            f"{server_setup}"
            "ENV SHELL=/bin/bash HOME=/root TERM=xterm-256color\n"
            "WORKDIR /root\n"
            "RUN printf '%s\\n' 'export PS1=\"\\u@\\h:\\w\\$ \"' > /root/.bashrc\n"
            "CMD [\"/bin/bash\"]\n"
            f"LABEL topology.role={kind}\n")


def build_files(data: object) -> tuple[dict[str, str], list[str]]:
    nodes, links = normalize(data)
    gui_nodes = [node for node in nodes if node["gui"]]
    server_nodes = [node for node in nodes if node["type"] == "server"]
    gui_password = data.get("guiPassword") if isinstance(data, dict) else None
    server_password = data.get("serverPassword") if isinstance(data, dict) else None
    project_name = data.get("projectName") if isinstance(data, dict) else None
    if project_name is None:
        identity = json.dumps([node["id"] for node in nodes], ensure_ascii=True, separators=(",", ":"))
        project_name = "topology-lab-" + hashlib.sha256(identity.encode()).hexdigest()[:12]
    if not isinstance(project_name, str) or not PROJECT_NAME_PATTERN.fullmatch(project_name):
        raise TopologyError("Compose 项目名须以小写字母或数字开头，只能包含小写字母、数字、-、_，最多 63 位")
    if gui_nodes:
        if gui_password is None:
            gui_password = secrets.token_urlsafe(16)
        if not isinstance(gui_password, str) or not GUI_PASSWORD_PATTERN.fullmatch(gui_password):
            raise TopologyError("GUI 密码必须为 8–64 位字母、数字、下划线或连字符")
    if server_nodes:
        if server_password is None:
            server_password = secrets.token_urlsafe(16)
        if not isinstance(server_password, str) or not SERVER_PASSWORD_PATTERN.fullmatch(server_password):
            raise TopologyError("服务器密码必须为 8–64 位字母、数字、下划线或连字符")
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
    mirror_receivers = {node["mirror"]["destination"] for node in nodes if node.get("mirror")}
    attachments = {node["id"]: [] for node in nodes if node["type"] != "switch"}
    for segment in segments:
        for member, interface in segment["members"].items():
            attachments[member].append((segment["key"], interface))
    lines = [f"name: {project_name}", "services:"]
    files = {}
    gui_ports = {}
    next_gui_port = 6901
    for node in nodes:
        node_id, kind, gui = node["id"], node["type"], node["gui"]
        if kind == "switch":
            continue  # One bridge per L2 domain; no pretend switch container.
        node_dockerfile = dockerfile(kind, gui)
        mirror = node.get("mirror")
        if mirror:
            endpoint_ips = {}
            for segment in segments:
                for endpoint in mirror.values():
                    if endpoint in segment["members"]:
                        endpoint_ips[endpoint] = segment["members"][endpoint]["ip"]
            source_ip = endpoint_ips[mirror["source"]]
            target_ip = endpoint_ips[mirror["target"]]
            destination_ip = endpoint_ips[mirror["destination"]]
            files[f"mirrors/{node_id}.nft"] = (
                f"table ip topology_mirror_{node_id.replace('-', '_')} {{\n"
                "  chain prerouting {\n"
                "    type filter hook prerouting priority mangle; policy accept;\n"
                f"    ip saddr {source_ip} ip daddr {target_ip} counter dup to {destination_ip}\n"
                f"    ip saddr {target_ip} ip daddr {source_ip} counter dup to {destination_ip}\n"
                "  }\n"
                "}\n"
            )
            node_dockerfile += f"COPY mirrors/{node_id}.nft /etc/topology-mirror.nft\n"
        files[f"dockerfiles/{node_id}.Dockerfile"] = node_dockerfile
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
            "    privileged: true",
        ])
        if kind == "router":
            lines.append("    platform: linux/arm64")
        if gui:
            gui_ports[node_id] = next_gui_port
            next_gui_port += 1
            lines.append("    shm_size: 512m")
        if gui or kind == "server":
            lines.append("    environment:")
            if gui:
                lines.append("      VNC_PW: ${VNC_PW}")
            if kind == "server":
                lines.append("      SERVER_PASSWORD: ${SERVER_PASSWORD}")
        if gui:
            lines.extend([
                "    ports:",
                f"      - \"127.0.0.1:{gui_ports[node_id]}:6901\"",
            ])
        if kind == "router":
            lines.extend(["    sysctls:", "      net.ipv4.ip_forward: \"1\""])
        elif node_id in mirror_receivers:
            lines.extend(["    sysctls:", "      net.ipv4.ip_forward: \"0\""])
        startup = list(commands[node_id])
        if mirror:
            startup.append("nft -f /etc/topology-mirror.nft")
        if kind == "server":
            startup.extend([
                f"printf '{SERVER_USERNAME}:%s\\n' \"$${{SERVER_PASSWORD}}\" | chpasswd",
                "mkdir -p /run/sshd /var/run/vsftpd/empty",
                "ssh-keygen -A",
                "/usr/sbin/sshd",
                "/usr/sbin/vsftpd /etc/vsftpd.conf",
                "/bin/busybox telnetd -p 23 -l /bin/login",
            ])
        if gui:
            hook = startup + (["apache2ctl start"] if kind == "server" else [])
            if hook:
                lines.extend([
                    "    post_start:",
                    "      - command: [\"sh\", \"-c\", " + yaml_string(" && ".join(hook)) + "]",
                    "        user: root",
                ])
        else:
            startup += ["exec apache2ctl -D FOREGROUND"] if kind == "server" else ["tail -f /dev/null"]
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
            "    driver_opts:",
            "      com.docker.network.bridge.enable_ip_masquerade: \"false\"",
            "    ipam:",
            "      config:",
            f"        - subnet: {segment['subnet']}",
        ])
    files["compose.yaml"] = "\n".join(lines) + "\n"
    environment = []
    if gui_ports:
        environment.append(f"VNC_PW={gui_password}")
    if server_nodes:
        environment.append(f"SERVER_PASSWORD={server_password}")
    if environment:
        files[".env"] = "\n".join(environment) + "\n"
    readme = ["# Generated topology", "", "Run `docker compose up --build -d` in this directory.", "When replacing an existing generated topology, run `docker compose down` first so Docker recreates the networks with the current driver options.", "Use `docker compose ps` to inspect containers and `docker compose down` to stop them.", "", "## Nodes", ""]
    for node in nodes:
        suffix = "，GUI" if node["gui"] else ""
        detail = "（Docker bridge 虚拟二层交换机，不创建容器）" if node["type"] == "switch" else ""
        readme.append(f"- `{node['id']}`: {node['name']} ({node['type']}{suffix}){detail}" + (f"; container=`{node_container_name(node)}`, hostname=`{node_hostname(node)}`" if node["type"] != "switch" else ""))
    readme.extend(["", "Every physical node container runs with `privileged: true`, allowing full container capabilities and device access for lab modifications. Switch nodes are Docker bridges and do not create containers.", "Changes made only inside a running container are lost when that container is rebuilt; put persistent changes in its Dockerfile or a mounted volume.", "Client/server images include Bash and common Linux tools such as ping, SSH, Telnet, FTP and netcat (`nc`); interactive Bash displays `root@hostname:~#`. Enter non-GUI containers with `docker exec -it <container-name> bash`.", "Every server node runs Apache HTTP Server on container port 80; access it from the topology with `http://<server-ip>/`. Apache's document root is `/var/www/html`.", "Every server also runs OpenSSH on port 22, BusyBox Telnet on port 23 and vsftpd on port 21. Sign in as `lab` with `SERVER_PASSWORD` from `.env`. FTP passive mode uses ports 30000–30009 inside the topology network.", "For DNS-safe ASCII node names, the hostname matches the visible name; names containing Chinese, spaces or invalid hostname characters use the node ID as hostname. The container name uses the visible node name where Docker-safe; invalid characters are replaced by hyphens and names consisting entirely of non-ASCII characters fall back to the node ID. The original visible name is kept in the `topology.name` label.", "OpenWrt router images retain the shells supplied by their rootfs (usually `sh`).", "", "## Layer-2 networks", "", "Each switch-connected domain (including interconnected switches) maps to one Docker bridge.", "IP masquerading is disabled on every generated bridge, so packets leaving a bridge retain the container source address; external networks need an explicit return route.", "All attached physical containers share the same subnet and can communicate without a router.", "Switch ports have no IP or MAC; the bridge's first host IP is reserved for the Docker gateway.", ""])
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
        readme.extend(["", "## GUI access", "", f"Open the following local HTTPS URLs after starting Compose. Sign in as `{GUI_USERNAME}`; the password is `VNC_PW` in `.env`.", ""])
        readme.extend(f"- `{node_id}`: https://localhost:{port}" for node_id, port in gui_ports.items())
        readme.extend(["", "GUI containers use Kasm's standalone desktop image and need Docker Compose with `post_start` support (v2.30+).", "They include ping, ip, curl, wget, SSH, Telnet, FTP, netcat (`nc`), traceroute, tcpdump, nmap and common terminal editors.", "The web sign-in name is `kasm_user`; the Linux desktop account is `kasm-user`. Run `sudo -i` in the desktop terminal for a passwordless root shell inside the container.", "The GUI server also runs Apache, OpenSSH, Telnet and vsftpd."])
    if server_nodes:
        readme.extend(["", "## Server access", "", f"All server nodes share the Linux username `{SERVER_USERNAME}` and the generated `SERVER_PASSWORD` stored in `.env`.", "", "- SSH: `ssh lab@<server-ip>` (port 22)", "- Telnet: `telnet <server-ip> 23`", "- FTP: `ftp <server-ip>` (port 21; passive ports 30000–30009)", "- HTTP: `http://<server-ip>/` (port 80)"])
    if has_router:
        readme.extend(["", "## Router image", "", "Router Dockerfiles unpack the bundled OpenWrt ARM64 rootfs. Run on ARM64 or a Docker host with ARM64 emulation."])
    mirrors = [node for node in nodes if node.get("mirror")]
    if mirrors:
        readme.extend(["", "## Traffic mirroring", "", "Each configured OpenWrt router uses nftables to duplicate IPv4 packets in both directions between the selected endpoints. The receiver must be directly connected to that router; mirrored packets keep their original IP headers, so inspect them with tcpdump rather than expecting an application on the receiver to accept them.", ""])
        node_by_id = {node["id"]: node for node in nodes}
        for node in mirrors:
            mirror = node["mirror"]
            receiver = node_by_id[mirror["destination"]]
            readme.append(f"- `{node['id']}`: `{mirror['source']}` ↔ `{mirror['target']}` → `{mirror['destination']}`; capture with `docker exec -it {node_container_name(receiver)} tcpdump -ni any`.")
        readme.append("Inspect rule counters on a router with `docker exec -it <router-container> nft list table ip topology_mirror_<router-id-with-underscores>`.")
    if warnings:
        readme.extend(["", "## Connectivity notes", ""])
        readme.extend(f"- {warning}" for warning in warnings)
    files["README.md"] = "\n".join(readme) + "\n"
    topology_snapshot = {"projectName": project_name, "nodes": nodes, "links": links}
    if gui_ports:
        topology_snapshot["guiPassword"] = gui_password
    if server_nodes:
        topology_snapshot["serverPassword"] = server_password
    files["topology.json"] = json.dumps(topology_snapshot, ensure_ascii=False, indent=2) + "\n"
    return files, warnings


def make_archive(files: dict[str, str], include_openwrt: bool) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
        if include_openwrt:
            archive.write(OPENWRT_ARCHIVE, OPENWRT_BUNDLE_PATH)
    return buffer.getvalue()


def choose_local_directory() -> Path:
    """The native picker is required because browser directory handles hide host paths."""
    if platform.system() != "Darwin" or not shutil.which("osascript"):
        raise NotImplementedError("此运行环境没有本机文件夹选择器")
    result = subprocess.run(
        ["osascript", "-e", 'POSIX path of (choose folder with prompt "选择 Docker 项目文件夹")'],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if result.returncode:
        if "-128" in result.stderr:
            raise TopologyError("已取消选择文件夹")
        raise TopologyError(f"无法选择文件夹：{result.stderr.strip() or '系统对话框出错'}")
    directory = Path(result.stdout.rstrip("\r\n")).resolve()
    if not directory.is_dir():
        raise TopologyError("所选目录不存在")
    return directory


def project_entries(files: dict[str, str], include_openwrt: bool) -> dict[str, bytes | Path]:
    entries: dict[str, bytes | Path] = {name: content.encode("utf-8") for name, content in files.items()}
    if include_openwrt:
        entries[OPENWRT_BUNDLE_PATH] = OPENWRT_ARCHIVE
    return entries


def safe_project_target(directory: Path, name: str) -> Path:
    parts = Path(name).parts
    if not parts or any(part in ("", ".", "..") for part in parts) or Path(name).is_absolute():
        raise TopologyError("生成文件路径无效")
    target = directory.joinpath(*parts)
    if any(path.is_symlink() for path in (target, *list(target.parents)[:len(parts)-1])):
        raise TopologyError(f"拒绝覆盖符号链接：{name}")
    if not target.resolve().is_relative_to(directory.resolve()):
        raise TopologyError(f"文件超出所选目录：{name}")
    return target


def write_project_file(directory: Path, name: str, contents: bytes | Path) -> bool:
    target = safe_project_target(directory, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(contents, bytes) and target.is_file() and target.read_bytes() == contents:
        return False
    if isinstance(contents, Path) and target.is_file() and target.stat().st_size == contents.stat().st_size:
        return False
    descriptor, temporary = tempfile.mkstemp(prefix=".topology-write-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            if isinstance(contents, Path):
                with contents.open("rb") as source:
                    shutil.copyfileobj(source, stream)
            else:
                stream.write(contents)
        if name == ".env":
            os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def compose_projects_for_directory(directory: Path) -> set[str]:
    """Find running or stopped Compose projects tied to this exact output file."""
    result = subprocess.run(["docker", "compose", "ls", "--all", "--format", "json"],
                            capture_output=True, text=True, timeout=30, check=False)
    if result.returncode:
        raise TopologyError(f"无法检查现有 Compose 项目：{result.stderr.strip()[-1000:]}")
    try:
        projects = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise TopologyError("无法解析现有 Compose 项目列表") from exc
    target = (directory / "compose.yaml").resolve()
    matches = set()
    for project in projects:
        files = project.get("ConfigFiles", "")
        if isinstance(files, str) and any(Path(path.strip()).resolve() == target for path in files.split(",") if path.strip()):
            name = project.get("Name")
            if isinstance(name, str) and PROJECT_NAME_PATTERN.fullmatch(name):
                matches.add(name)
    return matches


def run_compose(directory: Path, previous_compose: str | None, compose_changed: bool,
                approved_replacements: set[str] | None = None, progress=None) -> str:
    if not shutil.which("docker"):
        raise TopologyError("已写入文件，但未找到 Docker 命令。请安装并启动 Docker Desktop")

    build_steps: dict[str, tuple[str, int, int]] = {}
    build_totals: dict[str, int] = {}
    build_done: set[tuple[str, int]] = set()
    build_percent = 15

    def command(*args: str, phase: str) -> str:
        nonlocal build_percent
        if progress:
            output_lines: deque[str] = deque(maxlen=100)
            command_line = ["docker", "compose", "--ansi", "never", "--progress", "plain", *args]
            process = subprocess.Popen(command_line, cwd=directory, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       text=True, bufsize=1)
            expired = threading.Event()

            def stop_on_timeout():
                expired.set()
                process.kill()

            timer = threading.Timer(900, stop_on_timeout)
            timer.start()
            try:
                assert process.stdout is not None
                for raw_line in process.stdout:
                    line = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", raw_line).strip()
                    if not line:
                        continue
                    output_lines.append(line)
                    if phase == "build":
                        started = re.match(r"#(\d+) \[(?:(.+?) )?(\d+)/(\d+)\]", line)
                        if started:
                            step_id, service, step, total = started.groups()
                            service = service or "default"
                            build_steps[step_id] = (service, int(step), int(total))
                            build_totals[service] = max(build_totals.get(service, 0), int(total))
                        finished = re.match(r"#(\d+) (?:DONE|CACHED)\b", line)
                        if finished and finished.group(1) in build_steps:
                            service, step, _ = build_steps[finished.group(1)]
                            build_done.add((service, step))
                        if build_totals:
                            fraction = len(build_done) / sum(build_totals.values())
                            build_percent = max(build_percent, min(84, 15 + int(69 * fraction)))
                        progress("build", build_percent, line[:240])
                    else:
                        progress(phase, 90 if phase == "down" else 95, line[:240])
                returncode = process.wait()
            finally:
                timer.cancel()
                process.stdout.close()
            if expired.is_set():
                raise TopologyError("Docker Compose 执行超时（15 分钟）")
            output = "\n".join(output_lines)[-3000:]
            if returncode:
                raise TopologyError(f"文件已写入，但 Docker Compose 失败：{output}")
            return output
        try:
            result = subprocess.run(["docker", "compose", *args], cwd=directory,
                                    capture_output=True, text=True, timeout=900, check=False)
        except subprocess.TimeoutExpired as exc:
            raise TopologyError("Docker Compose 执行超时（15 分钟）") from exc
        output = (result.stdout + "\n" + result.stderr).strip()
        if result.returncode:
            raise TopologyError(f"文件已写入，但 Docker Compose 失败：{output[-3000:]}")
        return output[-3000:]

    current_compose = (directory / "compose.yaml").read_text(encoding="utf-8")
    current_match = re.match(r"^name: ([a-z0-9][a-z0-9_-]*)$", current_compose.splitlines()[0])
    if not current_match:
        raise TopologyError("已写入文件，但 Compose 项目名无效")
    current_name = current_match.group(1)
    if progress:
        progress("check", 12, "检查现有 Docker Compose 项目…")
    linked_projects = compose_projects_for_directory(directory)
    old_projects = linked_projects - {current_name}
    unapproved = old_projects - (approved_replacements or set())
    if unapproved:
        raise ComposeReplacementRequired(unapproved)
    if progress:
        progress("build", 15, "开始构建镜像…")
    command("build", phase="build")
    if progress:
        progress("build", 85, "镜像构建完成")
    stopped_projects = set()
    if previous_compose and compose_changed:
        # Use the last deployed definition so removed services and renamed projects stop too.
        previous_match = re.match(r"^name: ([a-z0-9][a-z0-9_-]*)$", previous_compose.splitlines()[0])
        descriptor, temporary = tempfile.mkstemp(prefix=".topology-previous-", suffix=".yaml", dir=directory)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(previous_compose)
            if progress:
                progress("down", 88, "停止旧项目并更新网络…")
            command("--project-directory", str(directory), "-f", temporary, "down", "--remove-orphans", phase="down")
            if previous_match:
                stopped_projects.add(previous_match.group(1))
        finally:
            os.unlink(temporary)
    for old_name in sorted(old_projects - stopped_projects):
        # A rename can leave the old project running even when its compose.yaml
        # has already been overwritten. -p targets only that same-folder project.
        if progress:
            progress("down", 88, f"停止旧项目 {old_name}…")
        command("-p", old_name, "down", "--remove-orphans", phase="down")
    if progress:
        progress("up", 92, "启动容器与网络…")
    output = command("up", "-d", "--remove-orphans", phase="up")
    if progress:
        progress("done", 100, "构建并启动完成")
    return output


def sync_local_project(data: object, progress=None) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("token"), str) or not isinstance(data.get("autoRun"), bool):
        raise TopologyError("本地同步请求无效")
    replacements = data.get("replaceProjects", [])
    if not isinstance(replacements, list) or any(not isinstance(name, str) or not PROJECT_NAME_PATTERN.fullmatch(name) for name in replacements):
        raise TopologyError("旧项目确认信息无效")
    with LOCAL_PROJECTS_LOCK:
        project = LOCAL_PROJECTS.get(data["token"])
    if project is None:
        raise TopologyError("文件夹关联已失效，请重新选择")
    topology = data.get("topology")
    files, _ = build_files(topology)
    has_router = any(node["type"] == "router" for node in normalize(topology)[0])
    with project["lock"]:
        directory = project["directory"]
        entries = project_entries(files, has_router)
        for name in entries:
            safe_project_target(directory, name)
        changed = []
        if progress:
            progress("write", 2, f"正在写入「{directory.name}」…")
        for index, (name, contents) in enumerate(entries.items(), 1):
            if write_project_file(directory, name, contents):
                changed.append(name)
            if progress:
                progress("write", 2 + int(8 * index / len(entries)), f"检查文件：{name}")
        previous = project.get("deployed_compose") or project.get("existing_compose")
        should_run = data["autoRun"] and (bool(changed) or previous != files["compose.yaml"] or not project.get("deployed"))
        output = ""
        if should_run:
            if progress:
                output = run_compose(directory, previous, previous != files["compose.yaml"], set(replacements), progress=progress)
            else:
                output = run_compose(directory, previous, previous != files["compose.yaml"], set(replacements))
            project["deployed_compose"] = files["compose.yaml"]
            project["deployed"] = True
            project.pop("existing_compose", None)
        elif progress:
            progress("done", 100, "文件已是最新，无需重新构建" if not changed else "文件同步完成")
        return {"changed": changed, "ran": should_run, "output": output}


class Handler(BaseHTTPRequestHandler):
    def send_bytes(self, status: int, body: bytes, mime: str, filename: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def stream_local_sync(self, data: object) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def send_event(event: dict) -> None:
            try:
                self.wfile.write((json.dumps(event, ensure_ascii=False) + "\n").encode())
                self.wfile.flush()
            except OSError:
                # A closed page must not interrupt a running Compose operation.
                pass

        try:
            result = sync_local_project(data, lambda phase, percent, message: send_event({
                "type": "progress", "phase": phase, "percent": percent, "message": message,
            }))
            send_event({"type": "result", **result})
        except ComposeReplacementRequired as exc:
            send_event({"type": "error", "error": str(exc), "replaceProjects": exc.projects})
        except (TopologyError, OSError, subprocess.SubprocessError) as exc:
            send_event({"type": "error", "error": str(exc)})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/local/capabilities":
            body = json.dumps({"nativePicker": platform.system() == "Darwin" and bool(shutil.which("osascript"))}).encode()
            self.send_bytes(200, body, "application/json; charset=utf-8")
            return
        if path == "/api/assets/openwrt-rootfs":
            if not OPENWRT_ARCHIVE.is_file():
                self.send_error(404)
                return
            self.send_bytes(200, OPENWRT_ARCHIVE.read_bytes(), "application/gzip")
            return
        names = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8")}
        if path not in names:
            self.send_error(404)
            return
        filename, mime = names[path]
        self.send_bytes(200, (STATIC / filename).read_bytes(), mime)

    def do_POST(self) -> None:
        if self.path not in ("/api/preview", "/api/download", "/api/local/select", "/api/local/sync", "/api/local/sync/stream"):
            self.send_error(404)
            return
        try:
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"):
                raise TopologyError("跨站请求已拒绝")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 1_000_000:
                raise TopologyError("请求内容过大或为空")
            data = json.loads(self.rfile.read(length))
            if self.path == "/api/local/sync/stream":
                self.stream_local_sync(data)
                return
            if self.path == "/api/local/sync":
                body = json.dumps(sync_local_project(data), ensure_ascii=False).encode()
                self.send_bytes(200, body, "application/json; charset=utf-8")
                return
            files, warnings = build_files(data)
            has_router = any(node["type"] == "router" for node in normalize(data)[0])
            if self.path == "/api/local/select":
                directory = choose_local_directory()
                entries = project_entries(files, has_router)
                collisions = [name for name in entries if safe_project_target(directory, name).exists()]
                token = secrets.token_urlsafe(32)
                with LOCAL_PROJECTS_LOCK:
                    existing_compose = (directory / "compose.yaml").read_text(encoding="utf-8") if (directory / "topology.json").is_file() and (directory / "compose.yaml").is_file() else None
                    LOCAL_PROJECTS[token] = {"directory": directory, "lock": threading.Lock(), "deployed": False,
                                             "existing_compose": existing_compose}
                body = json.dumps({"token": token, "name": directory.name, "collisions": collisions}, ensure_ascii=False).encode()
                self.send_bytes(200, body, "application/json; charset=utf-8")
                return
            if self.path == "/api/preview":
                assets = ([{"path": OPENWRT_BUNDLE_PATH,
                            "size": OPENWRT_ARCHIVE.stat().st_size,
                            "downloadUrl": "/api/assets/openwrt-rootfs"}]
                          if has_router else [])
                body = json.dumps({"files": files, "assets": assets, "warnings": warnings}, ensure_ascii=False).encode()
                self.send_bytes(200, body, "application/json; charset=utf-8")
            else:
                self.send_bytes(200, make_archive(files, has_router), "application/zip", "topology-lab.zip")
        except ComposeReplacementRequired as exc:
            body = json.dumps({"error": str(exc), "replaceProjects": exc.projects}, ensure_ascii=False).encode()
            self.send_bytes(409, body, "application/json; charset=utf-8")
        except NotImplementedError as exc:
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode()
            self.send_bytes(501, body, "application/json; charset=utf-8")
        except (TopologyError, json.JSONDecodeError, OSError, subprocess.SubprocessError) as exc:
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
