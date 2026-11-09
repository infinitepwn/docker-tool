import unittest
import io
import ipaddress
import json
import re
import zipfile

from app import OPENWRT_BUNDLE_PATH, TopologyError, build_files, make_archive, route_commands


def topology():
    return {
        "projectName": "topology-lab-test1234",
        "serverPassword": "ServerPass1234",
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


def mirrored_topology():
    return {
        "projectName": "topology-mirror-test",
        "nodes": [
            {"id": "client-1", "name": "源节点", "type": "client"},
            {"id": "router-1", "name": "路由器", "type": "router", "mirror": {"source": "client-1", "target": "client-2", "destination": "client-3"}},
            {"id": "client-2", "name": "目标节点", "type": "client"},
            {"id": "client-3", "name": "镜像接收节点", "type": "client"},
        ],
        "links": [
            {"id": f"link-{index}", "source": "router-1", "target": f"client-{index}", "subnet": f"10.240.{index}.0/24", "sourceIp": f"10.240.{index}.10", "targetIp": f"10.240.{index}.11", "sourceMac": f"02:42:f0:00:0{index}:01", "targetMac": f"02:42:f0:00:0{index}:02"}
            for index in (1, 2, 3)
        ],
    }


def mixed_subnet_switch_topology():
    return {
        "projectName": "mixed-subnet-test",
        "nodes": [
            {"id": "client-1", "name": "Client 1", "type": "client"},
            {"id": "client-2", "name": "Client 2", "type": "client"},
            {"id": "switch-1", "name": "Switch 1", "type": "switch"},
            {"id": "router-1", "name": "Router 1", "type": "router"},
            {"id": "server-1", "name": "Server 1", "type": "server"},
        ],
        "links": [
            {"id": "link-1", "source": "client-1", "target": "switch-1", "subnet": "10.210.1.0/24", "sourceIp": "10.210.1.10", "sourceMac": "02:42:d2:01:00:10"},
            {"id": "link-2", "source": "client-2", "target": "switch-1", "subnet": "10.210.2.0/24", "sourceIp": "10.210.2.10", "sourceMac": "02:42:d2:02:00:10"},
            {"id": "link-3", "source": "router-1", "target": "switch-1", "subnet": "10.210.1.0/24", "sourceIp": "10.210.1.20", "sourceMac": "02:42:d2:01:00:20"},
            {"id": "link-4", "source": "router-1", "target": "server-1", "subnet": "10.210.3.0/24", "sourceIp": "10.210.3.20", "targetIp": "10.210.3.10", "sourceMac": "02:42:d2:03:00:20", "targetMac": "02:42:d2:03:00:10"},
        ],
    }


class GeneratorTests(unittest.TestCase):
    def test_switch_accepts_multiple_subnets_without_fabricating_routes(self):
        data = mixed_subnet_switch_topology()
        files, warnings = build_files(data)
        compose = files["compose.yaml"]
        # All three switch ports are attached to the same Docker bridge.
        self.assertEqual(compose.count("      net_sw_switch-1:"), 3)
        self.assertEqual(compose.splitlines().count("  net_sw_switch-1:"), 1)
        # Each endpoint must receive its requested address and original mask.
        for address in ("10.210.1.10/24", "10.210.2.10/24", "10.210.1.20/24"):
            self.assertIn(address, compose)
        snapshot = json.loads(files["topology.json"])
        self.assertEqual([link["subnet"] for link in snapshot["links"]],
                         [link["subnet"] for link in data["links"]])
        commands, route_warnings = route_commands(data["nodes"], data["links"])
        self.assertIn("ip route replace 10.210.3.0/24 via 10.210.1.20 src 10.210.1.10", commands["client-1"])
        # Merely sharing an Ethernet segment does not make an off-subnet router a valid next hop.
        self.assertFalse(any("via 10.210.1.20" in command for command in commands["client-2"]))
        self.assertTrue(any("Client 2" in warning and "10.210.3.0/24" in warning for warning in route_warnings))
        self.assertTrue(warnings)

    def test_interconnected_switches_keep_endpoint_subnets(self):
        data = mixed_subnet_switch_topology()
        data["nodes"].append({"id": "switch-2", "name": "Switch 2", "type": "switch"})
        data["links"][1]["target"] = "switch-2"
        # A trunk has no IP address of its own; its legacy subnet field must not create one.
        data["links"].append({"id": "trunk-1", "source": "switch-1", "target": "switch-2", "subnet": "10.219.99.0/24"})
        files, _ = build_files(data)
        compose = files["compose.yaml"]
        self.assertEqual(compose.count("      net_sw_switch-1:"), 3)
        self.assertNotIn("net_sw_switch-2:", compose)
        self.assertIn("10.210.2.10/24", compose)
        commands, _ = route_commands(data["nodes"], data["links"])
        self.assertFalse(any("10.219.99.0/24" in command for routes in commands.values() for command in routes))

    def test_mixed_switch_subnets_may_not_overlap_another_l2_network(self):
        data = mixed_subnet_switch_topology()
        data["links"][3].update(subnet="10.210.2.128/25", sourceIp="10.210.2.130", targetIp="10.210.2.131")
        with self.assertRaisesRegex(TopologyError, "重叠"):
            build_files(data)

    def test_recursive_dns_acl_includes_each_switch_subnet(self):
        data = mixed_subnet_switch_topology()
        data["nodes"][4]["dnsServer"] = {"zone": "", "records": "", "recursion": True}
        files, _ = build_files(data)
        options = files["dns/server-1/named.conf.options"]
        for directive in ("allow-recursion", "allow-query-cache"):
            acl = options.split(directive, 1)[1].split("};", 1)[0]
            for subnet in ("10.210.1.0/24", "10.210.2.0/24", "10.210.3.0/24"):
                self.assertIn(subnet + ";", acl)

    def test_mixed_switch_auxiliary_network_is_blocked_but_gateway_remains_reachable(self):
        data = mixed_subnet_switch_topology()
        data["nodes"][0]["gui"] = True
        data["guiPassword"] = "DesktopPass1234"
        files, _ = build_files(data)
        compose = files["compose.yaml"]
        network_config = compose.split("\n  net_sw_switch-1:\n", 1)[1]
        pool = ipaddress.ip_network(re.search(r"- subnet: (\S+)", network_config).group(1))
        self.assertEqual(pool.prefixlen, 24)
        for node_id in ("client-1", "client-2", "router-1"):
            service = compose.split(f"\n  {node_id}:\n", 1)[1]
            service = re.split(r"\n  [A-Za-z0-9_-]+:\n", service, maxsplit=1)[0]
            with self.subTest(node=node_id):
                self.assertIn('pool=$$(ip -4 route show dev', service)
                self.assertIn('gateway=', service)
                self.assertIn('ip route replace blackhole', service)
                self.assertIn('$$pool', service)
                self.assertIn('$$gateway/32', service)
                self.assertLess(service.index("ip addr"), service.index("ip route replace blackhole"))
        server = compose.split("\n  server-1:\n", 1)[1].split("\nnetworks:", 1)[0]
        self.assertNotIn("blackhole", server)

    def test_dns_server_and_resolver_generation(self):
        data = topology()
        data["nodes"][0]["dnsResolver"] = "10.200.3.11"
        data["nodes"][3]["dnsServer"] = {
            "zone": "example.test.",
            "records": "@ A 10.200.3.11\nwww A 10.200.3.11\nalias CNAME www.example.test.",
        }
        files, _ = build_files(data)
        dns_dir = "dns/server-1/"
        for name in ("named.conf", "named.conf.options", "named.conf.local", "db.zone"):
            self.assertIn(dns_dir + name, files)
        self.assertIn('named.conf.options', files[dns_dir + "named.conf"])
        self.assertIn('named.conf.local', files[dns_dir + "named.conf"])
        self.assertIn('recursion no;', files[dns_dir + "named.conf.options"])
        self.assertIn('zone "example.test"', files[dns_dir + "named.conf.local"])
        zone = files[dns_dir + "db.zone"]
        self.assertIn('SOA', zone)
        self.assertIn('NS', zone)
        self.assertRegex(zone, r'example\.test\.\s+IN\s+A\s+10\.200\.3\.11')
        self.assertRegex(zone, r'www\.example\.test\.\s+IN\s+A\s+10\.200\.3\.11')
        self.assertRegex(zone, r'alias\.example\.test\.\s+IN\s+CNAME\s+www\.example\.test\.')
        dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn("bind9", dockerfile)
        self.assertIn("/etc/bind/", dockerfile)
        self.assertNotIn("bind9", files["dockerfiles/client-1.Dockerfile"])
        self.assertIn('    dns:\n      - "10.200.3.11"', files["compose.yaml"])
        self.assertIn("/usr/sbin/named", files["compose.yaml"])
        self.assertIn("-c /etc/bind/named.conf", files["compose.yaml"])
        self.assertNotIn("dnsmasq", "\n".join(files.values()))
        snapshot = json.loads(files["topology.json"])
        self.assertEqual(snapshot["nodes"][0]["dnsResolver"], "10.200.3.11")
        self.assertEqual(snapshot["nodes"][3]["dnsServer"], data["nodes"][3]["dnsServer"])
        self.assertIn("dig @<server-ip>", files["README.md"])
        archive = zipfile.ZipFile(io.BytesIO(make_archive(files, True)))
        for name in ("named.conf", "named.conf.options", "named.conf.local", "db.zone"):
            self.assertIn(dns_dir + name, archive.namelist())

    def test_dns_server_gui_uses_root_start_hook(self):
        data = topology()
        data["nodes"][3]["gui"] = True
        data["guiPassword"] = "DesktopPass1234"
        data["nodes"][3]["dnsServer"] = {"zone": "lab.test", "records": "www A 10.200.3.11"}
        files, _ = build_files(data)
        dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn("bind9", dockerfile)
        self.assertIn("/etc/bind/", dockerfile)
        server = files["compose.yaml"].split("  server-1:", 1)[1].split("\nnetworks:", 1)[0]
        self.assertIn("post_start:", server)
        self.assertIn("/usr/sbin/named", server)
        self.assertIn("        user: root", server)

    def test_recursive_dns_without_authoritative_zone(self):
        data = topology()
        data["nodes"][0]["dnsResolver"] = "10.200.3.11"
        data["nodes"][3]["dnsServer"] = {"zone": "", "records": "", "recursion": True}
        files, _ = build_files(data)
        options = files["dns/server-1/named.conf.options"]
        self.assertIn("recursion yes;", options)
        self.assertIn("dnssec-validation auto;", options)
        self.assertNotIn("forwarders", options)
        for directive in ("allow-recursion", "allow-query-cache"):
            acl = options.split(directive, 1)[1].split("};", 1)[0]
            self.assertIn("localhost;", acl)
            for subnet in ("10.200.1.0/24", "10.200.2.0/24", "10.200.3.0/24"):
                self.assertIn(subnet + ";", acl)
            self.assertNotIn("any;", acl)
        self.assertNotIn("zone ", files["dns/server-1/named.conf.local"])
        self.assertNotIn("dns/server-1/db.zone", files)
        self.assertNotIn("named-checkzone", files["dockerfiles/server-1.Dockerfile"])
        self.assertIn('    dns:\n      - "10.200.3.11"', files["compose.yaml"])
        self.assertEqual(json.loads(files["topology.json"])["nodes"][3]["dnsServer"], data["nodes"][3]["dnsServer"])

    def test_recursive_and_authoritative_servers_keep_independent_settings(self):
        data = topology()
        data["nodes"][3]["dnsServer"] = {"zone": "example.test", "records": "www A 10.200.3.11", "recursion": True}
        data["nodes"].append({"id": "server-2", "name": "服务器 2", "type": "server", "gui": True,
                              "dnsServer": {"zone": "other.test", "records": "www A 10.200.4.11", "recursion": False}})
        data["guiPassword"] = "DesktopPass1234"
        data["links"].append({"id": "link-4", "source": "router-2", "target": "server-2", "subnet": "10.200.4.0/24", "sourceIp": "10.200.4.10", "targetIp": "10.200.4.11", "sourceMac": "02:42:c8:00:04:01", "targetMac": "02:42:c8:00:04:02"})
        files, _ = build_files(data)
        self.assertIn("recursion yes;", files["dns/server-1/named.conf.options"])
        self.assertIn('zone "example.test"', files["dns/server-1/named.conf.local"])
        self.assertIn("www.example.test. IN A 10.200.3.11", files["dns/server-1/db.zone"])
        self.assertIn("recursion no;", files["dns/server-2/named.conf.options"])
        self.assertIn('zone "other.test"', files["dns/server-2/named.conf.local"])
        self.assertIn("www.other.test. IN A 10.200.4.11", files["dns/server-2/db.zone"])
        self.assertIn("post_start:", files["compose.yaml"].split("  server-2:", 1)[1])
        self.assertIn("/usr/sbin/named", files["compose.yaml"])

    def test_dns_recursion_validation(self):
        for config in (
            {"zone": "", "records": "", "recursion": False},
            {"zone": "", "records": "www A 10.200.3.11", "recursion": True},
            {"zone": "example.test", "records": "", "recursion": "true"},
            {"zone": "example.test", "records": "", "recursion": 1},
            {"zone": "example.test", "records": "", "recursion": None},
        ):
            with self.subTest(config=config):
                data = topology()
                data["nodes"][3]["dnsServer"] = config
                with self.assertRaises(TopologyError):
                    build_files(data)

    def test_recursive_dns_gui_starts_bind(self):
        data = topology()
        data["nodes"][3]["gui"] = True
        data["guiPassword"] = "DesktopPass1234"
        data["nodes"][3]["dnsServer"] = {"zone": "", "records": "", "recursion": True}
        files, _ = build_files(data)
        self.assertIn("recursion yes;", files["dns/server-1/named.conf.options"])
        server = files["compose.yaml"].split("  server-1:", 1)[1].split("\nnetworks:", 1)[0]
        self.assertIn("post_start:", server)
        self.assertIn("/usr/sbin/named", server)
        self.assertIn("        user: root", server)

    def test_recursive_dns_conditional_forwarding(self):
        data = topology()
        data["nodes"][3]["dnsServer"] = {
            "zone": "example.test", "records": "www A 10.200.3.11", "recursion": True,
            "forwardZones": "LAB.TEST. 10.200.1.10\nother.test 10.200.2.10",
        }
        files, _ = build_files(data)
        local = files["dns/server-1/named.conf.local"]
        self.assertIn('zone "example.test"', local)
        for name, address in (("lab.test", "10.200.1.10"), ("other.test", "10.200.2.10")):
            block = local.split(f'zone "{name}"', 1)[1].split("};", 1)[0]
            self.assertIn("type forward;", block)
            self.assertIn("forward only;", block)
            self.assertIn(f"{address};", block)
        exceptions = files["dns/server-1/named.conf.options"].split("validate-except", 1)[1].split("};", 1)[0]
        self.assertIn("lab.test", exceptions)
        self.assertIn("other.test", exceptions)
        self.assertEqual(json.loads(files["topology.json"])["nodes"][3]["dnsServer"], data["nodes"][3]["dnsServer"])
        data["nodes"][3]["dnsServer"]["recursion"] = False
        files, _ = build_files(data)
        self.assertNotIn("type forward;", files["dns/server-1/named.conf.local"])
        self.assertEqual(json.loads(files["topology.json"])["nodes"][3]["dnsServer"]["forwardZones"], data["nodes"][3]["dnsServer"]["forwardZones"])

    def test_dns_rejects_invalid_forward_zones(self):
        for forward_zones in (
            "bad/name 10.200.1.10", "lab.test 2001:db8::1", "lab.test 999.1.1.1",
            "lab.test 10.200.1.10; recursion yes", "lab.test", "lab.test 10.200.1.10 extra",
            "lab.test 10.200.1.10\nLAB.TEST. 10.200.2.10", "example.test 10.200.1.10",
            True,
        ):
            with self.subTest(forward_zones=forward_zones):
                data = topology()
                data["nodes"][3]["dnsServer"] = {"zone": "example.test", "records": "", "recursion": True,
                                                 "forwardZones": forward_zones}
                with self.assertRaises(TopologyError):
                    build_files(data)

    def test_dns_nameserver_does_not_conflict_with_user_cname(self):
        data = topology()
        data["nodes"][3]["dnsServer"] = {
            "zone": "example.test",
            "records": "www A 10.200.3.11\nns CNAME www",
        }
        files, _ = build_files(data)
        zone = files["dns/server-1/db.zone"]
        self.assertRegex(zone, r'@\s+IN\s+NS\s+ns0\.example\.test\.')
        self.assertRegex(zone, r'ns0\.example\.test\.\s+IN\s+A\s+10\.200\.3\.11')
        self.assertRegex(zone, r'ns\.example\.test\.\s+IN\s+CNAME\s+www\.example\.test\.')

    def test_dns_rejects_invalid_records_and_injection(self):
        for records in ("www A 2001:db8::1", "www TXT arbitrary", "www A 1.2.3.4\nserver=8.8.8.8",
                        "bad/name A 1.2.3.4", "alias CNAME external.example.",
                        "alias CNAME missing", "www A 1.2.3.4\nwww CNAME www",
                        "www A 1.2.3.4\na CNAME www\na CNAME www",
                        "www A 1.2.3.4\n@ CNAME www"):
            with self.subTest(records=records):
                data = topology()
                data["nodes"][3]["dnsServer"] = {"zone": "example.test", "records": records}
                with self.assertRaises(TopologyError):
                    build_files(data)
        for resolver in ("8.8.8.8\n  privileged: true", "2001:db8::1", "999.1.1.1"):
            data = topology()
            data["nodes"][0]["dnsResolver"] = resolver
            with self.assertRaises(TopologyError):
                build_files(data)
        data = topology()
        data["nodes"][1]["dnsServer"] = {"zone": "example.test", "records": ""}
        with self.assertRaises(TopologyError):
            build_files(data)

    def test_legacy_topology_does_not_enable_dns_server(self):
        files, _ = build_files(topology())
        self.assertFalse(any(path.startswith("dns/") for path in files))
        self.assertNotIn("bind9", files["dockerfiles/server-1.Dockerfile"])
        self.assertNotIn("/usr/sbin/named", files["compose.yaml"])
        self.assertNotIn("    dns:", files["compose.yaml"])

    def test_web_server_selection_and_legacy_default(self):
        for value in (None, "apache", "nginx"):
            with self.subTest(web_server=value):
                data = topology()
                if value is not None:
                    data["nodes"][3]["webServer"] = value
                files, _ = build_files(data)
                selected = value or "apache"
                dockerfile = files["dockerfiles/server-1.Dockerfile"]
                compose = files["compose.yaml"]
                server = compose.split("\n  server-1:\n", 1)[1].split("\nnetworks:", 1)[0]
                self.assertEqual(json.loads(files["topology.json"])["nodes"][3]["webServer"], selected)
                self.assertIn(f"`server-1`: {'Apache' if selected == 'apache' else 'Nginx'}", files["README.md"])
                if selected == "apache":
                    self.assertIn("apache2", dockerfile)
                    self.assertNotIn("nginx", dockerfile)
                    self.assertIn("exec apache2ctl -D FOREGROUND", server)
                else:
                    self.assertIn("nginx", dockerfile)
                    self.assertNotIn("apache2", dockerfile)
                    self.assertIn("exec /usr/sbin/nginx -g 'daemon off;'", server)
                    self.assertNotIn("apache2ctl", server)
                for service in ("/usr/sbin/sshd", "/usr/sbin/vsftpd", "telnetd"):
                    self.assertIn(service, server)

    def test_nginx_gui_starts_with_dns_and_mixed_switch(self):
        data = mixed_subnet_switch_topology()
        data["links"][3] = {"id": "link-4", "source": "switch-1", "target": "server-1",
                            "subnet": "10.210.3.0/24", "targetIp": "10.210.3.10",
                            "targetMac": "02:42:d2:03:00:10"}
        data["nodes"][4].update(gui=True, webServer="nginx",
                                dnsServer={"zone": "lab.test", "records": "www A 10.210.3.10", "recursion": True})
        data["guiPassword"] = "DesktopPass1234"
        files, _ = build_files(data)
        dockerfile = files["dockerfiles/server-1.Dockerfile"]
        server = files["compose.yaml"].split("\n  server-1:\n", 1)[1].split("\nnetworks:", 1)[0]
        self.assertIn("nginx", dockerfile)
        self.assertIn("bind9", dockerfile)
        self.assertNotIn("apache2", dockerfile)
        self.assertIn("post_start:", server)
        self.assertIn("user: root", server)
        self.assertIn("/usr/sbin/nginx", server)
        self.assertIn("/usr/sbin/named", server)
        self.assertIn("10.210.3.10/24", server)
        self.assertIn('zone "lab.test"', files["dns/server-1/named.conf.local"])
        self.assertIn("recursion yes;", files["dns/server-1/named.conf.options"])

    def test_invalid_web_server_selections_are_rejected(self):
        for value in ("", "Nginx", "none", "nginx; echo injected", None, True, 1, {}):
            with self.subTest(web_server=value):
                data = topology()
                data["nodes"][3]["webServer"] = value
                with self.assertRaises(TopologyError):
                    build_files(data)
        for index in (0, 1):
            data = topology()
            data["nodes"][index]["webServer"] = "nginx"
            with self.assertRaises(TopologyError):
                build_files(data)

    def test_router_mirrors_bidirectional_traffic(self):
        data = mirrored_topology()
        files, warnings = build_files(data)
        self.assertFalse(warnings)
        rules = files["mirrors/router-1.nft"]
        self.assertIn("ip saddr 10.240.1.11 ip daddr 10.240.2.11 counter dup to 10.240.3.11", rules)
        self.assertIn("ip saddr 10.240.2.11 ip daddr 10.240.1.11 counter dup to 10.240.3.11", rules)
        self.assertIn("COPY mirrors/router-1.nft /etc/topology-mirror.nft", files["dockerfiles/router-1.Dockerfile"])
        self.assertIn("nft -f /etc/topology-mirror.nft", files["compose.yaml"])
        self.assertIn('net.ipv4.ip_forward: "0"', files["compose.yaml"])
        self.assertIn("tcpdump -ni any", files["README.md"])
        self.assertEqual(json.loads(files["topology.json"])["nodes"][1]["mirror"], data["nodes"][1]["mirror"])
        self.assertIn("mirrors/router-1.nft", zipfile.ZipFile(io.BytesIO(make_archive(files, True))).namelist())

    def test_invalid_router_mirror_is_rejected(self):
        data = mirrored_topology()
        data["nodes"][1]["mirror"]["destination"] = "client-1"
        with self.assertRaisesRegex(TopologyError, "三个不同"):
            build_files(data)
        data = mirrored_topology()
        data["nodes"][1]["mirror"]["target"] = "unknown"
        with self.assertRaisesRegex(TopologyError, "三个不同"):
            build_files(data)
        data = mirrored_topology()
        data["links"][1]["subnet"] = "10.240.1.0/24"
        data["links"][1]["sourceIp"] = "10.240.1.12"
        data["links"][1]["targetIp"] = "10.240.1.13"
        with self.assertRaisesRegex(TopologyError, "重叠"):
            build_files(data)

    def test_multi_router_routes_and_files(self):
        data = topology()
        commands, warnings = route_commands(data["nodes"], data["links"])
        self.assertFalse(warnings)
        self.assertIn("ip route replace 10.200.3.0/24 via 10.200.1.11", commands["client-1"])
        self.assertIn("ip route replace 10.200.1.0/24 via 10.200.3.10", commands["server-1"])
        files, warnings = build_files(data)
        self.assertFalse(warnings)
        self.assertIn("net.ipv4.ip_forward", files["compose.yaml"])
        self.assertTrue(files["compose.yaml"].startswith("name: topology-lab-test1234\n"))
        self.assertIn("mac_address: 02:42:c8:00:01:01", files["compose.yaml"])
        self.assertEqual(files["compose.yaml"].count("    privileged: true"), 4)
        self.assertNotIn("cap_add:", files["compose.yaml"])
        self.assertEqual(files["compose.yaml"].count('com.docker.network.bridge.enable_ip_masquerade: "false"'), 3)
        server_dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn("apache2", server_dockerfile)
        self.assertIn("openssh-server", server_dockerfile)
        self.assertIn("vsftpd", server_dockerfile)
        self.assertIn("busybox-static", server_dockerfile)
        self.assertIn("inetutils-telnet", server_dockerfile)
        self.assertIn("inetutils-ftp", server_dockerfile)
        self.assertIn("useradd -m -s /bin/bash lab", server_dockerfile)
        self.assertIn("PasswordAuthentication yes", server_dockerfile)
        self.assertIn("pasv_min_port=30000", server_dockerfile)
        self.assertIn("ServerName localhost", server_dockerfile)
        self.assertIn("EXPOSE 21 22 23 80 30000-30009", server_dockerfile)
        self.assertIn("SERVER_PASSWORD: ${SERVER_PASSWORD}", files["compose.yaml"])
        self.assertIn("ssh-keygen -A", files["compose.yaml"])
        self.assertIn("/usr/sbin/sshd", files["compose.yaml"])
        self.assertIn("/usr/sbin/vsftpd /etc/vsftpd.conf", files["compose.yaml"])
        self.assertIn("/bin/busybox telnetd -p 23 -l /bin/login", files["compose.yaml"])
        self.assertIn("$${SERVER_PASSWORD}", files["compose.yaml"])
        self.assertIn("exec apache2ctl -D FOREGROUND", files["compose.yaml"])
        self.assertNotIn("python3 -m http.server", files["compose.yaml"])
        self.assertIn("selected Apache or Nginx HTTP server on container port 80", files["README.md"])
        self.assertIn("BusyBox Telnet on port 23", files["README.md"])
        self.assertEqual(files[".env"], "SERVER_PASSWORD=ServerPass1234\n")
        self.assertEqual(json.loads(files["topology.json"])["serverPassword"], "ServerPass1234")
        self.assertEqual(json.loads(files["topology.json"])["projectName"], "topology-lab-test1234")
        self.assertIn("Every physical node container runs with `privileged: true`", files["README.md"])
        self.assertIn("dockerfiles/client-1.Dockerfile", files)
        self.assertIn("netcat-openbsd", files["dockerfiles/client-1.Dockerfile"])
        self.assertIn("netcat (`nc`)", files["README.md"])

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
        self.assertIn("iputils-ping", gui_dockerfile)
        self.assertIn("openssh-client", gui_dockerfile)
        self.assertIn("inetutils-telnet", gui_dockerfile)
        self.assertIn("inetutils-ftp", gui_dockerfile)
        self.assertIn("netcat-openbsd", gui_dockerfile)
        self.assertIn("tcpdump", gui_dockerfile)
        self.assertIn("nmap", gui_dockerfile)
        self.assertIn("kasm-user ALL=(ALL) NOPASSWD: ALL", gui_dockerfile)
        self.assertLess(gui_dockerfile.index("USER root"), gui_dockerfile.index("USER 1000"))
        self.assertIn('127.0.0.1:6901:6901', compose)
        self.assertIn('127.0.0.1:6902:6901', compose)
        self.assertEqual(compose.count('    privileged: true'), 4)
        self.assertIn('post_start:', compose)
        gui_server_dockerfile = files["dockerfiles/server-1.Dockerfile"]
        self.assertIn('apache2 openssh-server vsftpd busybox-static', gui_server_dockerfile)
        self.assertIn('ServerName localhost', gui_server_dockerfile)
        self.assertIn('EXPOSE 21 22 23 80 30000-30009', gui_server_dockerfile)
        self.assertIn('PasswordAuthentication yes', gui_server_dockerfile)
        self.assertIn('pasv_max_port=30009', gui_server_dockerfile)
        self.assertIn('apache2ctl start', compose)
        self.assertIn('/usr/sbin/sshd', compose)
        self.assertIn('/usr/sbin/vsftpd /etc/vsftpd.conf', compose)
        self.assertIn('/bin/busybox telnetd -p 23 -l /bin/login', compose)
        self.assertNotIn('python3 -m http.server', compose)
        self.assertEqual(files['.env'], 'VNC_PW=DesktopPass1234\nSERVER_PASSWORD=ServerPass1234\n')
        self.assertIn('Sign in as `kasm_user`', files['README.md'])
        self.assertIn('Run `sudo -i`', files['README.md'])
        self.assertEqual(json.loads(files['topology.json'])['guiPassword'], 'DesktopPass1234')
        self.assertEqual(json.loads(files['topology.json'])['serverPassword'], 'ServerPass1234')
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

    def test_rejects_invalid_server_password(self):
        data = topology()
        data["serverPassword"] = "short"
        with self.assertRaisesRegex(TopologyError, "服务器密码"):
            build_files(data)


if __name__ == "__main__":
    unittest.main()
