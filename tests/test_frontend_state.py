import json
import shutil
import subprocess
import unittest
from pathlib import Path


class FrontendStateTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node.js is required to test keyboard interaction')
    def test_keyboard_selection_connection_and_cancellation(self):
        root = Path(__file__).resolve().parents[1]
        subprocess.run(['node', str(root / 'tests' / 'frontend_keyboard.js'),
                        str(root / 'static' / 'app.js')], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which('node'), 'Node.js is required to test browser state restoration')
    def test_saved_topology_restores_server_choices(self):
        saved = {
            'projectName': 'saved-lab',
            'serverPassword': 'SavedPass123',
            'nodes': [{'id': 'server-1', 'name': 'server', 'type': 'server',
                       'webServer': 'nginx',
                       'dnsServer': {'zone': '', 'records': '', 'recursion': True}}],
            'links': [],
        }
        script = r'''
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[1], 'utf8').split('function save()')[0];
const stored = process.argv[2];
const context = {
  document: {querySelector: () => ({})},
  localStorage: {getItem: () => stored},
  crypto: {getRandomValues: () => { throw new Error('unexpected password reset'); }},
};
vm.runInNewContext(source + '\nresult = topology;', context);
process.stdout.write(JSON.stringify(context.result));
'''
        source_path = Path(__file__).resolve().parents[1] / 'static' / 'app.js'
        result = subprocess.run(['node', '-e', script, str(source_path), json.dumps(saved)],
                                check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout), saved)


if __name__ == '__main__':
    unittest.main()
