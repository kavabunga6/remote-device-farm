#!/usr/bin/env python3
"""Require ADB authentication in the farm image before Android starts adbd.

Preserve the SDK ramdisk's files and archive boundaries. No extracted paths,
root override or permissive SELinux policy. Unknown formats fail the build.
"""
import gzip
from pathlib import Path
import re
import subprocess
import sys

def secure_ramdisk(image):
    """Use Android init's early property override to require ADB authentication.

    No archive paths are extracted. Preserve all original records verbatim,
    replacing only the two init override files; unknown formats fail the build.
    """
    replaced = {b'force_debuggable', b'adb_debug.prop'}
    compressed = image.startswith(b'\x1f\x8b')
    lz4 = image.startswith((b'\x02\x21\x4c\x18', b'\x04\x22\x4d\x18'))
    if lz4:
        # SDK images use both legacy and framed LZ4. The small official CLI
        # handles both; gzip output is supported by the same Android kernels.
        decoded = subprocess.run(['lz4', '-d', '-c'], input=image,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=True)
        data = decoded.stdout
    else:
        data = gzip.decompress(image) if compressed else image
    if len(data) > 256 * 1024 * 1024:
        raise ValueError('Upstream ramdisk exceeds the supported size')
    archives, offset = [], 0
    while offset < len(data):
        # A ramdisk may concatenate generic and vendor newc archives. Preserve
        # the trailer boundaries: the kernel resets its hardlink table there.
        while offset < len(data) and data[offset] == 0:
            offset += 1
        if offset == len(data):
            break
        if offset % 4:
            raise ValueError('Unaligned upstream ramdisk archive')
        records, max_inode = [], 0
        while offset + 110 <= len(data):
            start = offset
            header = data[offset:offset + 110]
            if header[:6] not in (b'070701', b'070702') or not re.fullmatch(b'[0-9a-fA-F]{104}', header[6:]):
                raise ValueError('Unsupported upstream ramdisk: expected newc archive')
            fields = [int(header[i:i + 8], 16) for i in range(6, 110, 8)]
            inode, size, name_size = fields[0], fields[6], fields[11]
            if not 1 <= name_size <= 4096:
                raise ValueError('Invalid ramdisk entry name')
            offset += 110
            name_end = offset + name_size
            content_start = (name_end + 3) & ~3
            content_end = content_start + size
            next_offset = (content_end + 3) & ~3
            if next_offset > len(data) or data[name_end - 1:name_end] != b'\0':
                raise ValueError('Truncated upstream ramdisk')
            name = data[offset:name_end - 1]
            if b'\0' in name:
                raise ValueError('Invalid ramdisk entry name')
            canonical = name[2:] if name.startswith(b'./') else name
            offset = next_offset
            if canonical == b'TRAILER!!!':
                if size:
                    raise ValueError('Invalid upstream ramdisk trailer')
                archives.append((records, data[start:offset], max_inode))
                break
            if canonical not in replaced:
                max_inode = max(max_inode, inode)
                records.append(data[start:offset])
        else:
            raise ValueError('Upstream ramdisk has no newc trailer')
    if not archives:
        raise ValueError('Upstream ramdisk has no newc archive')
    if archives[-1][2] > 0xfffffffb:
        raise ValueError('Ramdisk inode range is unsupported')

    def entry(name, content, inode):
        name = name + b'\0'
        fields = [inode, 0o100644, 0, 0, 1, 0, len(content), 0, 0, 0, 0, len(name), 0]
        result = b'070701' + ''.join(format(field, '08x') for field in fields).encode() + name
        result += b'\0' * (-len(result) % 4)
        result += content
        return result + b'\0' * (-len(result) % 4)

    # init copies adb_debug.prop from the merged first-stage root before
    # SwitchRoot and loads it last, before adbd starts. Add it to the final
    # archive so preceding vendor records cannot replace the secure property.
    records, trailer, max_inode = archives[-1]
    records.append(entry(b'force_debuggable', b'', max_inode + 1))
    records.append(entry(b'adb_debug.prop', b'ro.adb.secure=1\n', max_inode + 2))
    output = []
    for records, trailer, _ in archives:
        archive = b''.join(records) + trailer
        archive += b'\0' * (-len(archive) % 512)
        output.append(archive)
    result = b''.join(output)
    return gzip.compress(result, mtime=0) if compressed or lz4 else result


if __name__ == '__main__':
    path = Path(sys.argv[1])
    original = path.read_bytes()
    secured = secure_ramdisk(original)
    path.write_bytes(secured)
    print('rdf-emulator: ramdisk requires authenticated ADB')
