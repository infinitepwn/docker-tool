import http.client
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import ComposeReplacementRequired, Handler, LOCAL_PROJECTS, ThreadingHTTPServer, TopologyError, build_files, run_compose, safe_project_target


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
    def test_compose_progress_streams_before_command_finishes(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            token = None
            release = threading.Event()
            try:
                def fake_compose(directory, previous, changed, approved, progress=None):
                    self.assertIsNotNone(progress)
                    progress("build", 35, "#1 [client-1 1/4] RUN apt-get update")
                    self.assertTrue(release.wait(3), "the client did not receive build progress promptly")
                    progress("done", 100, "构建并启动完成")
                    return "started"

                with patch("app.choose_local_directory", return_value=Path(temporary)), patch("app.run_compose", side_effect=fake_compose):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                    connection.request("POST", "/api/local/select", json.dumps(sample()).encode(), {"Content-Type": "application/json"})
                    selected = json.loads(connection.getresponse().read())
                    token = selected["token"]
                    connection.close()

                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                    payload = {"token": token, "topology": sample(), "autoRun": True}
                    connection.request("POST", "/api/local/sync/stream", json.dumps(payload).encode(), {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    events = []
                    while True:
                        event = json.loads(response.readline())
                        events.append(event)
                        if event.get("phase") == "build":
                            break
                    self.assertIn("apt-get update", events[-1]["message"])
                    release.set()
                    rest = [json.loads(line) for line in response if line.strip()]
                    self.assertTrue(any(event["type"] == "result" and event["ran"] for event in rest))
                    connection.close()
            finally:
                release.set()
                if token:
                    LOCAL_PROJECTS.pop(token, None)
                server.shutdown()
                server.server_close()

    def test_buildkit_steps_update_progress(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "compose.yaml").write_text("name: progress_lab\nservices: {}\n")
            updates = []
            calls = []

            def fake_process(args, **kwargs):
                calls.append(args)
                output = "#1 [1/2] FROM ubuntu:24.04\n#1 DONE 0.1s\n#2 [2/2] RUN apt-get update\n#2 DONE 0.2s\n" if args[-1] == "build" else "Container client-1 Started\n"
                return SimpleNamespace(stdout=io.StringIO(output), wait=lambda: 0, kill=lambda: None)

            with patch("app.shutil.which", return_value="/usr/local/bin/docker"), patch("app.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="[]", stderr="")), patch("app.subprocess.Popen", side_effect=fake_process):
                run_compose(root, None, False, progress=lambda *event: updates.append(event))
            self.assertEqual(calls[0][-1], "build")
            self.assertIn("--progress", calls[0])
            self.assertTrue(any(phase == "build" and percent > 15 for phase, percent, _ in updates))
            self.assertEqual(updates[-1][:2], ("done", 100))

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
            (Path(temporary) / "compose.yaml").write_text("name: new_lab\nservices: {}\n")
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout="[]" if "ls" in args else "ok", stderr="")

            with patch("app.shutil.which", return_value="/usr/local/bin/docker"), patch("app.subprocess.run", side_effect=fake_run):
                run_compose(Path(temporary), "name: older_lab\nservices: {}\n", True)
            self.assertEqual(calls[0], ["docker", "compose", "ls", "--all", "--format", "json"])
            self.assertEqual(calls[1], ["docker", "compose", "build"])
            self.assertEqual(calls[2][-2:], ["down", "--remove-orphans"])
            self.assertEqual(calls[3], ["docker", "compose", "up", "-d", "--remove-orphans"])

    def test_detects_old_project_after_compose_name_was_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "compose.yaml").write_text("name: lab3\nservices: {}\n")
            projects = [{"Name": "topology-lab", "ConfigFiles": str(root / "compose.yaml")},
                        {"Name": "unrelated", "ConfigFiles": "/another/project/compose.yaml"}]
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0, stdout=json.dumps(projects) if "ls" in args else "ok", stderr="")

            with patch("app.shutil.which", return_value="/usr/local/bin/docker"), patch("app.subprocess.run", side_effect=fake_run):
                with self.assertRaises(ComposeReplacementRequired):
                    run_compose(root, None, False)
                self.assertEqual(len(calls), 1)
                calls.clear()
                run_compose(root, None, False, {"topology-lab"})
            self.assertEqual(calls[1], ["docker", "compose", "build"])
            self.assertEqual(calls[2], ["docker", "compose", "-p", "topology-lab", "down", "--remove-orphans"])
            self.assertEqual(calls[3], ["docker", "compose", "up", "-d", "--remove-orphans"])

    def test_sync_requires_explicit_confirmation_for_other_project_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            token = None
            try:
                def post(path, payload):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", path, json.dumps(payload).encode(), {"Content-Type": "application/json"})
                    response = connection.getresponse()
                    content = json.loads(response.read())
                    connection.close()
                    return response.status, content

                def guarded_run(directory, previous, changed, approved):
                    if "old_lab" not in approved:
                        raise ComposeReplacementRequired({"old_lab"})
                    return "started"

                with patch("app.choose_local_directory", return_value=Path(temporary)), patch("app.run_compose", side_effect=guarded_run):
                    status, selected = post("/api/local/select", sample())
                    self.assertEqual(status, 200)
                    token = selected["token"]
                    payload = {"token": token, "topology": sample(), "autoRun": True}
                    status, blocked = post("/api/local/sync", payload)
                    self.assertEqual(status, 409)
                    self.assertEqual(blocked["replaceProjects"], ["old_lab"])
                    status, completed = post("/api/local/sync", {**payload, "replaceProjects": ["old_lab"]})
                    self.assertEqual(status, 200)
                    self.assertTrue(completed["ran"])
            finally:
                if token:
                    LOCAL_PROJECTS.pop(token, None)
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
