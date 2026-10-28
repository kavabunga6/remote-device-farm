#!/usr/bin/env python3
"""Require authenticated ADB before Android starts adbd."""
import importlib.util
from pathlib import Path
import sys

# Load the bundled parser by path so launchers also work when imported by tooling.
_ramdisk_spec = importlib.util.spec_from_file_location('rdf_ramdisk', Path(__file__).with_name('ramdisk.py'))
_ramdisk = importlib.util.module_from_spec(_ramdisk_spec)
_ramdisk_spec.loader.exec_module(_ramdisk)
secure_ramdisk = _ramdisk.secure_ramdisk


if __name__ == '__main__':
    path = Path(sys.argv[1])
    original = path.read_bytes()
    secured = secure_ramdisk(original)
    path.write_bytes(secured)
    print('rdf-emulator: ramdisk requires authenticated ADB')
