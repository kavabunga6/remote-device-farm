import base64
import importlib.util
import gzip
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('adapter', Path(__file__).with_name('launcher.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def public_key():
    raw = bytearray(524)
    struct.pack_into('<I', raw, 0, 64)
    struct.pack_into('<I', raw, 520, 65537)
    return base64.b64encode(raw).decode() + ' test-agent'


def cpio_entry(name, data=b'', mode=0o100644, inode=1):
    filename = name.encode() + b'\0'
    fields = [inode, mode, 0, 0, 1, 1234, len(data), 0, 0, 0, 0, len(filename), 0]
    result = b'070701' + b''.join(('%08x' % field).encode() for field in fields) + filename
    result += b'\0' * (-len(result) % 4)
    result += data
    return result + b'\0' * (-len(result) % 4)


def read_cpio(data):
    offset, entries = 0, []
    while True:
        header = data[offset:offset + 110]
        size, namesize = int(header[54:62], 16), int(header[94:102], 16)
        name = data[offset + 110:offset + 110 + namesize - 1].decode()
        start = (offset + 110 + namesize + 3) & ~3
        entries.append((name, data[start:start + size], int(header[14:22], 16)))
        offset = (start + size + 3) & ~3
        if name == 'TRAILER!!!':
            return entries


class LauncherTest(unittest.TestCase):
    def test_farm_resource_and_environment_flags_are_preserved_as_argv(self):
        value = '-no-snapshot -partition-size 8192 -memory 2048 -cores 2 -sdcard /android-home/rdf-sdcard.img -gpu swiftshader_indirect'
        args = adapter.parse_params(value)
        self.assertEqual(args, value.split())
        command = adapter.launch_command(args, public_key().split()[0])
        self.assertEqual(command[-len(args):], args)
        self.assertEqual(command.count('-no-snapshot'), 1)
        self.assertIn('5556,5557', command)
        self.assertIn('8555', command)
        self.assertNotIn('-skip-adb-auth', command)
        self.assertEqual(command.count('-no-metrics'), 1)
        self.assertEqual(command.count('-no-direct-adb'), 1)
        self.assertIn('androidboot.verifiedbootstate=orange', command)
        self.assertIn('androidboot.qemu.adb.pubkey=' + public_key().split()[0], command)
        self.assertIn('/usr/local/lib/rdf-hqarroum/secure-ramdisk.img', command)
        self.assertEqual(adapter.parse_params('-timezone Europe/Moscow -change-language ru -change-country RU -netspeed lte -netdelay none -camera-back emulated -screen multi-touch'),
                         '-timezone Europe/Moscow -change-language ru -change-country RU -netspeed lte -netdelay none -camera-back emulated -screen multi-touch'.split())

    def test_security_network_and_shell_overrides_are_rejected(self):
        for value in ['-skip-adb-auth', '-qemu -append androidboot.verifiedbootstate=orange', '-grpc 0',
                      '-no-direct-adb', '-ports 5554,5555', '-append-userspace-opt androidboot.qemu.adb.pubkey=evil', '-ramdisk /tmp/insecure', '-gpu host', '-sdcard /etc/passwd', '-memory 0',
                      '-cores 17', '-partition-size 1000000', '-no-audio -noaudio',
                      '-no-window;touch /tmp/bad', '$(touch /tmp/bad)', '-memory 2048\n-skip-adb-auth']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                adapter.parse_params(value)

    def test_avd_config_replaces_values_without_duplicates_and_keeps_baked_image_paths(self):
        overrides = adapter.parse_avd_config('disk.dataPartition.size=8192M\nhw.sdCard=yes\nsdcard.size=128M\nsdcard.path=/android-home/rdf-sdcard.img')
        template = 'image.sysdir.1=/opt/android/system-images/android-33/google_apis/x86_64/\nhw.sdCard=no\ndisk.dataPartition.size=2048M\n'
        merged = adapter.merge_config(template, overrides)
        self.assertEqual(merged.count('disk.dataPartition.size='), 1)
        self.assertIn('disk.dataPartition.size=8192M\n', merged)
        self.assertIn('image.sysdir.1=/opt/android/system-images/android-33/google_apis/x86_64/', merged)
        for value in ['image.sysdir.1=/tmp/other', 'hw.sdCard=no\nhw.sdCard=yes',
                      'sdcard.path=/tmp/key', 'disk.dataPartition.size=1T', 'hw.sdCard=true']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                adapter.parse_avd_config(value)

    def test_only_the_agent_public_key_is_installed_and_an_existing_private_key_is_removed(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / '.android'
            directory.mkdir()
            (directory / 'adbkey').write_text('untrusted upstream private key')
            (directory / 'adbkey.pub').write_text('untrusted upstream public key')
            adapter.install_public_key(public_key(), directory)
            self.assertFalse((directory / 'adbkey').exists())
            key = directory / 'adbkey.pub'
            self.assertEqual(key.read_text(), public_key().split()[0] + ' rdf-agent\n')
            if os.name != 'nt':
                self.assertEqual(key.stat().st_mode & 0o777, 0o400)
            key.chmod(0o600)  # Windows temporary-directory cleanup needs writable files.

    def test_missing_malformed_or_multiline_keys_fail_before_emulator_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            for value in [None, '', 'ssh-rsa abc', 'AAAA', public_key() + '\nsecond-key', public_key() + '\0']:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    adapter.install_public_key(value, Path(temp) / '.android')
            self.assertFalse((Path(temp) / '.android/adbkey.pub').exists())

    def test_secure_ramdisk_preserves_original_files_and_replaces_only_auth_override(self):
        init_record = cpio_entry('init', b'../system/bin/init', mode=0o120777, inode=10)
        fstab_record = cpio_entry('first_stage_ramdisk/fstab.ranchu', b'unchanged verified mounts\n', inode=11)
        old_property = cpio_entry('./adb_debug.prop', b'ro.adb.secure=0\nro.debuggable=1\n')
        original = init_record + fstab_record + old_property + cpio_entry('force_debuggable') + cpio_entry('TRAILER!!!')
        for compressed in (False, True):
            with self.subTest(compressed=compressed):
                image = gzip.compress(original) if compressed else original
                result = adapter.secure_ramdisk(image)
                decoded = gzip.decompress(result) if compressed else result
                self.assertTrue(decoded.startswith(init_record + fstab_record))
                entries = read_cpio(decoded)
                self.assertEqual([row[0] for row in entries].count('force_debuggable'), 1)
                self.assertEqual([row for row in entries if row[0] == 'adb_debug.prop'],
                                 [('adb_debug.prop', b'ro.adb.secure=1\n', 0o100644)])
                self.assertNotIn(b'ro.debuggable=', decoded)
                self.assertNotIn(b'ro.adb.secure=0', decoded)
                self.assertEqual(adapter.secure_ramdisk(result), result)

    def test_concatenated_generic_and_vendor_archives_keep_boundaries_and_all_records(self):
        generic_record = cpio_entry('init', b'generic-init', mode=0o100750, inode=7)
        vendor_record = cpio_entry('first_stage_ramdisk/fstab.ranchu', b'vendor-fstab', inode=7)
        generic = generic_record + cpio_entry('adb_debug.prop', b'ro.adb.secure=0\n') + cpio_entry('TRAILER!!!')
        generic += b'\0' * (-len(generic) % 512)
        vendor = vendor_record + cpio_entry('force_debuggable') + cpio_entry('TRAILER!!!')
        image = gzip.compress(generic + vendor)
        decoded = gzip.decompress(adapter.secure_ramdisk(image))
        # The first archive still ends at its own trailer; inode 7 in the
        # second archive must not be interpreted as a link to generic init.
        first = read_cpio(decoded)
        self.assertEqual(first, [('init', b'generic-init', 0o100750), ('TRAILER!!!', b'', 0o100644)])
        second_offset = decoded.index(vendor_record)
        self.assertEqual(second_offset % 512, 0)
        second = read_cpio(decoded[second_offset:])
        self.assertEqual(second[0], ('first_stage_ramdisk/fstab.ranchu', b'vendor-fstab', 0o100644))
        self.assertEqual(second[1:3], [('force_debuggable', b'', 0o100644),
                                      ('adb_debug.prop', b'ro.adb.secure=1\n', 0o100644)])
        self.assertEqual(decoded.count(b'TRAILER!!!'), 2)
        self.assertNotIn(b'ro.adb.secure=0', decoded)
        self.assertEqual(gzip.decompress(adapter.secure_ramdisk(gzip.compress(decoded))), decoded)

    def test_android12_ramdisk_copies_original_policy_bytes_without_changes(self):
        original = cpio_entry('init', b'generic-init') + cpio_entry('TRAILER!!!')
        policy = b'; Original image platform policy\n(type init)\n(type system_server)\n'
        rows = read_cpio(adapter.secure_ramdisk(original, policy))
        self.assertEqual([row for row in rows if row[0] == 'userdebug_plat_sepolicy.cil'],
                         [('userdebug_plat_sepolicy.cil', policy, 0o100644)])
        self.assertEqual([row for row in rows if row[0] == 'adb_debug.prop'],
                         [('adb_debug.prop', b'ro.adb.secure=1\n', 0o100644)])
        self.assertNotIn('userdebug_plat_sepolicy.cil', [row[0] for row in read_cpio(adapter.secure_ramdisk(original))])
        for invalid in (b'', b'; empty policy', 'not bytes'):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                adapter.secure_ramdisk(original, invalid)

    def test_android12_policy_accepts_only_matching_pinned_base_and_original_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            base = 'halimqarroum/docker-android@sha256:' + 'a' * 64
            package = 'system-images;android-31;google_apis;x86_64'
            policy = b'; original platform CIL\n(type init)\n'
            (directory / 'source.properties').write_bytes(b'AndroidVersion.ApiLevel=31\nPkg.Revision=12\n')
            (directory / 'ramdisk.img').write_bytes(b'exact original ramdisk')
            source_files = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                            for name in ('source.properties', 'ramdisk.img')}
            manifest = {'schemaVersion': 1, 'upstream': base, 'package': package,
                        'sourceFiles': source_files, 'sourcePath': '/system/etc/selinux/plat_sepolicy.cil',
                        'buildFingerprint': 'original-exact-guest-build',
                        'policy': {'file': 'policy-api31.cil.gz', 'bytes': len(policy),
                                   'sha256': hashlib.sha256(policy).hexdigest()}}
            (directory / 'policy-api31.json').write_text(json.dumps(manifest))
            (directory / 'policy-api31.cil.gz').write_bytes(gzip.compress(policy, mtime=0))
            with patch.object(adapter.subprocess, 'run') as run:
                result, report = adapter.read_platform_policy(directory, package, base, directory)
            run.assert_not_called()
            self.assertEqual(result, policy)
            self.assertEqual(report, {**manifest, 'copiedWithoutChanges': True})
            for wrong_base in ('', 'halimqarroum/docker-android:api-31', base[:-1] + 'b'):
                with self.subTest(base=wrong_base), self.assertRaises(ValueError):
                    adapter.read_platform_policy(directory, package, wrong_base, directory)
            with self.assertRaises(ValueError):
                adapter.read_platform_policy(directory, package.replace('31', '32'), base, directory)
            (directory / 'ramdisk.img').write_bytes(b'different Android build')
            with self.assertRaisesRegex(ValueError, 'source identity'):
                adapter.read_platform_policy(directory, package, base, directory)
            (directory / 'ramdisk.img').write_bytes(b'exact original ramdisk')
            (directory / 'policy-api31.cil.gz').write_bytes(gzip.compress(policy.replace(b'init', b'evil')))
            with self.assertRaisesRegex(ValueError, 'checksum or length'):
                adapter.read_platform_policy(directory, package, base, directory)

    def test_android12_manifest_cannot_select_an_unrelated_policy_file(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            base = 'halimqarroum/docker-android@sha256:' + 'a' * 64
            package = 'system-images;android-31;google_apis;x86_64'
            for name in ('source.properties', 'ramdisk.img'):
                (directory / name).write_bytes(b'original')
            sources = {name: hashlib.sha256(b'original').hexdigest()
                       for name in ('source.properties', 'ramdisk.img')}
            manifest = {'schemaVersion': 1, 'upstream': base, 'package': package,
                        'sourceFiles': sources, 'policy': {'file': '../foreign.cil.gz',
                                                          'bytes': 1, 'sha256': 'a' * 64}}
            (directory / 'policy-api31.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'manifest is invalid'):
                adapter.read_platform_policy(directory, package, base, directory)
            manifest['sourceFiles'] = {}
            (directory / 'policy-api31.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'source identities'):
                adapter.read_platform_policy(directory, package, base, directory)

    def test_lz4_ramdisk_is_decoded_then_repacked_with_secure_properties(self):
        archive = cpio_entry('init', b'init-binary') + cpio_entry('TRAILER!!!')
        for magic in (b'\x02\x21\x4c\x18', b'\x04\x22\x4d\x18'):
            image = magic + b'compressed test fixture'
            with self.subTest(magic=magic), patch.object(adapter.subprocess, 'run') as run:
                run.return_value = subprocess.CompletedProcess([], 0, archive, b'')
                result = adapter.secure_ramdisk(image)
                self.assertEqual(run.call_args.args, (['lz4', '-d', '-c'],))
                self.assertEqual(run.call_args.kwargs['input'], image)
                self.assertTrue(run.call_args.kwargs['check'])
                self.assertEqual(run.call_args.kwargs['timeout'], 60)
                self.assertIn(('adb_debug.prop', b'ro.adb.secure=1\n', 0o100644), read_cpio(gzip.decompress(result)))
        with patch.object(adapter.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['lz4'])):
            with self.assertRaises(subprocess.CalledProcessError):
                adapter.secure_ramdisk(b'\x02\x21\x4c\x18broken')

    def test_ramdisk_unknown_truncated_or_trailing_garbage_formats_fail_closed(self):
        valid = cpio_entry('init', b'init-binary') + cpio_entry('TRAILER!!!')
        bad_name = bytearray(valid)
        bad_name[114] = 65  # the first entry's terminating NUL
        for image in [b'not a ramdisk', valid[:80], valid[:-40], bytes(bad_name),
                      valid + cpio_entry('another'), gzip.compress(valid + b'garbage'),
                      b'070701' + b'x' * 104]:
            with self.subTest(image=image[:16]), self.assertRaises(ValueError):
                adapter.secure_ramdisk(image)

    def test_upstream_auth_and_resource_environment_cannot_override_the_farm(self):
        env = adapter.clean_env({'PATH': '/usr/bin', 'HOME': '/root', 'SKIP_AUTH': 'true', 'EXTRA_FLAGS': '-skip-adb-auth',
                                 'MEMORY': '8192', 'CORES': '4', 'GPU_ACCELERATED': 'true', 'ADBKEY': 'private',
                                 'ADBKEY_PUB': public_key(), 'ADB_VENDOR_KEYS': '/root/.android/adbkey',
                                 'ANDROID_ADB_SERVER_ADDRESS': 'remote'})
        self.assertEqual(env['HOME'], '/android-home/home')
        self.assertEqual(env['ANDROID_AVD_HOME'], '/android-home/avd')
        for key in ['SKIP_AUTH', 'EXTRA_FLAGS', 'MEMORY', 'CORES', 'GPU_ACCELERATED', 'ADBKEY', 'ADBKEY_PUB', 'ADB_VENDOR_KEYS', 'ANDROID_ADB_SERVER_ADDRESS']:
            self.assertNotIn(key, env)
        self.assertEqual(env['PATH'], '/usr/bin')


if __name__ == '__main__':
    unittest.main()
