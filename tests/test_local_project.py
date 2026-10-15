import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import Handler, LOCAL_PROJECTS, ThreadingHTTPServer, TopologyError, build_files, run_compose, safe_project_target


def sample(name="my_lab"):
    return {
        "projectName": name,
        "serverPassword": "ServerPass1234",
        "nodes": [
            {"id": "client-1", "name": "client", "type": "client"},
            {"id": "server-1", "name": "server", "type": "server"},
        ],
        "links": [{"id": "link-1", "source": "client-1", "target": "server-1",
                   "subnet": "10.210.1.0/24", "sourceIp": "10.210.1.10", "targetIp": "10.210.1.11",
                   "sourceMac": "02:42:d2:00:01:01", "targetMac": "02:42:d2:00:01:02"}],
    }


class LocalProjectTests(unittest.TestCase):
    def test_editable_compose_name(self):
        files, _ = build_files(sample("custom_network_1"))
        self.assertTrue(files["compose.yaml"].startswith("name: custom_network_1\n"))
        for invalid in ("Uppercase", "-starts-with-dash", "with space", "x" * 64):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(TopologyError, "Compose 项目名"):
                build_files(sample(invalid))

    def test_local_selection_sync_and_auto_compose(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "keep.txt").write_text("unchanged")
            (root / "compose.yaml").write_text("name: older_lab\nservices: {}\n")
            (root / "topology.json").write_text("{}\n")
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                def post(path, payload):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", path, json.dumps(payload).encode(),
                                       {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{server.server_port}"})
                    response = connection.getresponse()
                    content = json.loads(response.read())
                    connection.close()
                    self.assertEqual(response.status, 200, content)
                    return content

                with patch("app.choose_local_directory", return_value=root), patch("app.run_compose", return_value="started") as compose:
                    selected = post("/api/local/select", sample())
                    self.assertIn("compose.yaml", selected["collisions"])
                    token = selected["token"]
                    first = post("/api/local/sync", {"token": token, "topology": sample(), "autoRun": True})
                    self.assertTrue(first["ran"])
                    self.assertIn("compose.yaml", first["changed"])
                    self.assertIn("name: older_lab\n", compose.call_args.args[1])
                    self.assertTrue(compose.call_args.args[2])
                    self.assertTrue((root / "compose.yaml").read_text().startswith("name: my_lab\n"))
                    self.assertEqual((root / "keep.txt").read_text(), "unchanged")
                    second = post("/api/local/sync", {"token": token, "topology": sample(), "autoRun": True})
                    self.assertEqual(second["changed"], [])
                    self.assertFalse(second["ran"])
                    third = post("/api/local/sync", {"token": token, "topology": sample("renamed_lab"), "autoRun": True})
                    self.assertTrue(third["ran"])
                    self.assertTrue((root / "compose.yaml").read_text().startswith("name: renamed_lab\n"))
                    self.assertEqual(compose.call_count, 2)
                    self.assertIn("name: my_lab\n", compose.call_args.args[1])
                    self.assertTrue(compose.call_args.args[2])
                    LOCAL_PROJECTS.pop(token, None)
            finally:
                server.shutdown()
                server.server_close()

    def test_rejects_symlinked_output_directory(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            (Path(root) / "dockerfiles").symlink_to(outside)
            with self.assertRaisesRegex(TopologyError, "符号链接"):
                safe_project_target(Path(root), "dockerfiles/client-1.Dockerfile")

    def test_auto_compose_builds_then_replaces_old_project(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout="ok", stderr="")

            with patch("app.shutil.which", return_value="/usr/local/bin/docker"), patch("app.subprocess.run", side_effect=fake_run):
                run_compose(Path(temporary), "name: older_lab\nservices: {}\n", True)
            self.assertEqual(calls[0], ["docker", "compose", "build"])
            self.assertEqual(calls[1][0:2], ["docker", "compose"])
            self.assertEqual(calls[1][-2:], ["down", "--remove-orphans"])
            self.assertEqual(calls[2], ["docker", "compose", "up", "-d", "--remove-orphans"])


if __name__ == "__main__":
    unittest.main()
