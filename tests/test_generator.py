import unittest
import io
import json
import zipfile

from app import OPENWRT_BUNDLE_PATH, TopologyError, build_files, make_archive, route_commands


def topology():
    return {
        "nodes": [
            {"id": "client-1", "name": "客户端 A", "type": "client"},
            {"id": "router-1", "name": "路由 1", "type": "router"},
            {"id": "router-2", "name": "路由 2", "type": "router"},
            {"id": "server-1", "name": "服务器", "type": "server"},
        ],
        "links": [
            {"id": "link-1", "source": "client-1", "target": "router-1", "subnet": "10.200.1.0/24", "sourceIp": "10.200.1.10", "targetIp": "10.200.1.11", "sourceMac": "02:42:c8:00:01:01", "targetMac": "02:42:c8:00:01:02"},
            {"id": "link-2", "source": "router-1", "target": "router-2", "subnet": "10.200.2.0/24", "sourceIp": "10.200.2.10", "targetIp": "10.200.2.11", "sourceMac": "02:42:c8:00:02:01", "targetMac": "02:42:c8:00:02:02"},
            {"id": "link-3", "source": "router-2", "target": "server-1", "subnet": "10.200.3.0/24", "sourceIp": "10.200.3.10", "targetIp": "10.200.3.11", "sourceMac": "02:42:c8:00:03:01", "targetMac": "02:42:c8:00:03:02"},
        ],
    }


class GeneratorTests(unittest.TestCase):
    def test_multi_router_routes_and_files(self):
        data = topology()
        commands, warnings = route_commands(data["nodes"], data["links"])
        self.assertFalse(warnings)
        self.assertIn("ip route replace 10.200.3.0/24 via 10.200.1.11", commands["client-1"])
        self.assertIn("ip route replace 10.200.1.0/24 via 10.200.3.10", commands["server-1"])
        files, warnings = build_files(data)
        self.assertFalse(warnings)
        self.assertIn("net.ipv4.ip_forward", files["compose.yaml"])
        self.assertIn("mac_address: 02:42:c8:00:01:01", files["compose.yaml"])
        self.assertEqual(files["compose.yaml"].count('com.docker.network.bridge.enable_ip_masquerade: "false"'), 3)
        server_dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn("apache2", server_dockerfile)
        self.assertIn("ServerName localhost", server_dockerfile)
        self.assertIn("EXPOSE 80", server_dockerfile)
        self.assertIn("exec apache2ctl -D FOREGROUND", files["compose.yaml"])
        self.assertNotIn("python3 -m http.server", files["compose.yaml"])
        self.assertIn("Apache HTTP Server on container port 80", files["README.md"])
        self.assertIn("dockerfiles/client-1.Dockerfile", files)

    def test_rejects_overlapping_networks(self):
        data = topology()
        data["links"][1]["subnet"] = "10.200.1.128/25"
        data["links"][1]["sourceIp"] = "10.200.1.130"
        data["links"][1]["targetIp"] = "10.200.1.131"
        with self.assertRaisesRegex(TopologyError, "重叠"):
            build_files(data)

    def test_rejects_duplicate_mac_and_bad_ip(self):
        data = topology()
        data["links"][1]["sourceMac"] = data["links"][0]["sourceMac"]
        with self.assertRaisesRegex(TopologyError, "MAC 地址重复"):
            build_files(data)
        data = topology()
        data["links"][0]["sourceIp"] = "10.200.1.0"
        with self.assertRaisesRegex(TopologyError, "不在可用网段"):
            build_files(data)
        data = topology()
        data["links"][0]["sourceIp"] = "10.200.1.1"
        with self.assertRaisesRegex(TopologyError, "不在可用网段"):
            build_files(data)

    def test_rejects_too_small_subnet(self):
        data = topology()
        data["links"][0]["subnet"] = "10.200.1.8/30"
        with self.assertRaisesRegex(TopologyError, "/29"):
            build_files(data)

    def test_non_router_cannot_transit(self):
        data = topology()
        data["nodes"][1]["type"] = "client"
        with self.assertRaisesRegex(TopologyError, "只能连接一条线"):
            build_files(data)

    def test_openwrt_router_and_gui_services(self):
        data = topology()
        data["nodes"][0]["gui"] = True
        data["nodes"][3]["gui"] = True
        data["guiPassword"] = "DesktopPass1234"
        files, _ = build_files(data)
        compose = files["compose.yaml"]
        self.assertIn("FROM scratch", files["dockerfiles/router-1.Dockerfile"])
        self.assertIn(f"ADD {OPENWRT_BUNDLE_PATH} /", files["dockerfiles/router-1.Dockerfile"])
        self.assertIn("platform: linux/arm64", compose)
        gui_dockerfile = files["dockerfiles/client-1.Dockerfile"]
        self.assertIn("FROM kasmweb/ubuntu-focal-desktop:1.16.0", gui_dockerfile)
        self.assertIn("apt-get install -y --no-install-recommends sudo", gui_dockerfile)
        self.assertIn("kasm-user ALL=(ALL) NOPASSWD: ALL", gui_dockerfile)
        self.assertLess(gui_dockerfile.index("USER root"), gui_dockerfile.index("USER 1000"))
        self.assertIn('127.0.0.1:6901:6901', compose)
        self.assertIn('127.0.0.1:6902:6901', compose)
        self.assertIn('post_start:', compose)
        gui_server_dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn('apt-get install -y --no-install-recommends sudo apache2', gui_server_dockerfile)
        self.assertIn('ServerName localhost', gui_server_dockerfile)
        self.assertIn('EXPOSE 80', gui_server_dockerfile)
        self.assertIn('apache2ctl start', compose)
        self.assertNotIn('python3 -m http.server', compose)
        self.assertEqual(files['.env'], 'VNC_PW=DesktopPass1234\n')
        self.assertIn('Sign in as `kasm_user`', files['README.md'])
        self.assertIn('Run `sudo -i`', files['README.md'])
        self.assertEqual(json.loads(files['topology.json'])['guiPassword'], 'DesktopPass1234')
        archive = zipfile.ZipFile(io.BytesIO(make_archive(files, True)))
        self.assertIn(OPENWRT_BUNDLE_PATH, archive.namelist())
        self.assertEqual(archive.read(OPENWRT_BUNDLE_PATH)[:2], b'\x1f\x8b')

    def test_rejects_gui_router(self):
        data = topology()
        data["nodes"][1]["gui"] = True
        with self.assertRaisesRegex(TopologyError, "GUI 配置无效"):
            build_files(data)

    def test_rejects_invalid_gui_password(self):
        data = topology()
        data["nodes"][0]["gui"] = True
        data["guiPassword"] = "short"
        with self.assertRaisesRegex(TopologyError, "GUI 密码"):
            build_files(data)


if __name__ == "__main__":
    unittest.main()
