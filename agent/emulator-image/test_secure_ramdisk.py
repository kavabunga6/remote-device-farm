import gzip
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('secure_ramdisk', Path(__file__).with_name('secure-ramdisk.py'))
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

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


class SecureRamdiskTest(unittest.TestCase):
    def test_preserves_files_modes_and_archive_boundaries(self):
        generic = cpio_entry('init', b'../system/bin/init', 0o120777, 7) + cpio_entry('TRAILER!!!')
        generic += b'\0' * (-len(generic) % 512)
        vendor = cpio_entry('first_stage_ramdisk/fstab.ranchu', b'verified mounts', 0o100644, 7)
        old = cpio_entry('./adb_debug.prop', b'ro.adb.secure=0\nro.debuggable=1\n')
        original = generic + vendor + old + cpio_entry('force_debuggable') + cpio_entry('TRAILER!!!')
        for compressed in (False, True):
            with self.subTest(compressed=compressed):
                image = gzip.compress(original) if compressed else original
                result = patcher.secure_ramdisk(image)
                decoded = gzip.decompress(result) if compressed else result
                self.assertTrue(decoded.startswith(generic + vendor))
                self.assertEqual(decoded.count(b'TRAILER!!!'), 2)
                second = read_cpio(decoded[len(generic):])
                self.assertEqual(second[1:3], [('force_debuggable', b'', 0o100644),
                                              ('adb_debug.prop', b'ro.adb.secure=1\n', 0o100644)])
                self.assertNotIn(b'ro.adb.secure=0', decoded)
                self.assertNotIn(b'ro.debuggable=', decoded)
                self.assertEqual(patcher.secure_ramdisk(result), result)

    def test_unknown_or_truncated_archives_fail_closed(self):
        for image in (b'unknown', cpio_entry('init', b'data'), cpio_entry('TRAILER!!!')[:-1]):
            with self.subTest(image=image[:10]):
                with self.assertRaises(ValueError):
                    patcher.secure_ramdisk(image)

if __name__ == '__main__':
    unittest.main()
