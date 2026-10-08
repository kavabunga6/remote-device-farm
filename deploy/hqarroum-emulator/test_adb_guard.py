import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SHELL = shutil.which('sh')
if not SHELL and os.name == 'nt':
    git_shell = Path('C:/Program Files/Git/bin/bash.exe')
    SHELL = str(git_shell) if git_shell.is_file() else None
GUARD = Path(__file__).with_name('adb-guard.sh')


@unittest.skipUnless(SHELL, 'A POSIX shell is required for the SDK ADB guard')
class AdbGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='rdf adb guard ')
        self.directory = Path(self.temp.name)
        self.guard = self.directory / 'adb'
        self.guard.write_text(GUARD.read_text(encoding='utf-8-sig'), encoding='utf-8', newline='\n')
        self.guard.chmod(0o755)
        self.marker = self.directory / 'real-adb-executed'
        self.key = self.directory / 'adbkey'
        real = self.directory / 'adb.rdf-real'
        real.write_text('#!/bin/sh\n'
                        'printf "%s\\n" "$*" > "$GUARD_MARKER"\n'
                        'printf "%s\\n" "Android Debug Bridge version 1.0.41"\n'
                        'exit "${REAL_ADB_STATUS:-0}"\n', encoding='utf-8', newline='\n')
        real.chmod(0o755)
        self.env = dict(os.environ, GUARD_MARKER=self.marker.as_posix(), HOME=self.directory.as_posix())

    def tearDown(self):
        self.temp.cleanup()

    def run_guard(self, *args, env=None):
        return subprocess.run([SHELL, self.guard.as_posix(), *args], env=env or self.env,
                              capture_output=True, text=True, timeout=5)

    def test_only_exact_version_queries_execute_the_preserved_binary(self):
        for argument in ['version', '--version']:
            with self.subTest(argument=argument):
                result = self.run_guard(argument)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stdout, 'Android Debug Bridge version 1.0.41\n')
                self.assertEqual(result.stderr, '')
                self.assertEqual(self.marker.read_text().strip(), argument)
                self.assertFalse(self.key.exists())
        failed_version = self.run_guard('version', env=dict(self.env, REAL_ADB_STATUS='7'))
        self.assertEqual(failed_version.returncode, 7)

    def test_internal_helpers_daemons_and_keygen_never_execute_real_adb(self):
        commands = [[], ['start-server'], ['server', 'nodaemon'],
                    ['keygen', self.key.as_posix()],
                    ['-e', 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '2147483647'],
                    ['-s', 'emulator-5556', 'shell', 'getprop'],
                    ['version', 'start-server'], ['--version', 'keygen', self.key.as_posix()],
                    ['connect', '127.0.0.1:5557'], ['devices'], ['kill-server']]
        for command in commands:
            with self.subTest(command=command):
                result = self.run_guard(*command)
                self.assertEqual(result.returncode, 69)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'SDK-local ADB is disabled; use the farm ADB connection.\n')
                self.assertFalse(self.marker.exists())
                self.assertFalse(self.key.exists())
                self.assertFalse((self.directory / '.android').exists())


if __name__ == '__main__':
    unittest.main()
