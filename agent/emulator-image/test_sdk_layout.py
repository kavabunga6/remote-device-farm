"""Check the launcher's SDK layout contract without downloading Android."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
BASH = ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash"))


@unittest.skipUnless(BASH and Path(BASH).exists(), "Bash is required")
class SdkLayoutTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rdf-sdk-layout-")
        self.addCleanup(self.temporary.cleanup)
        self.sdk = Path(self.temporary.name)
        for name in ("emulator/emulator", "platform-tools/adb"):
            path = self.sdk / name
            path.parent.mkdir(parents=True)
            path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            path.chmod(0o755)
        self.image = self.sdk / "system-images/android-34/google_apis/x86_64"
        self.image.mkdir(parents=True)
        (self.image / "system.img").touch()

    def check(self):
        return subprocess.run([BASH, (HERE / "rdf-emulator.sh").as_posix(), "--check-image"],
                              env={**os.environ, "ANDROID_SDK_ROOT": self.sdk.as_posix()},
                              capture_output=True, text=True, timeout=5)

    def test_complete_sdk_with_one_system_image_is_valid(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("image layout is valid", result.stdout)

    def test_sdk_without_official_platform_tools_is_rejected(self):
        (self.sdk / "platform-tools/adb").unlink()
        result = self.check()
        self.assertEqual(result.returncode, 64)
        self.assertIn("SDK platform-tools/adb is missing", result.stderr)

    def test_missing_emulator_is_rejected(self):
        (self.sdk / "emulator/emulator").unlink()
        result = self.check()
        self.assertEqual(result.returncode, 64)
        self.assertIn("emulator binary is missing", result.stderr)

    def test_zero_or_multiple_system_images_are_rejected(self):
        extra = self.sdk / "system-images/android-35/default/x86_64"
        extra.mkdir(parents=True)
        result = self.check()
        self.assertEqual(result.returncode, 64)
        self.assertIn("expected exactly one system image, found 2", result.stderr)
        extra.rmdir()
        (self.image / "system.img").unlink()
        self.image.rmdir()
        result = self.check()
        self.assertEqual(result.returncode, 64)
        self.assertIn("expected exactly one system image, found 0", result.stderr)


if __name__ == "__main__":
    unittest.main()
