#!/usr/bin/env python3
"""Adapt HQarroum's installed SDK to the farm's existing container contract."""
import base64
import ipaddress
import os
from pathlib import Path
import re
import secrets
import signal
import struct
import subprocess
import sys
import time

SDK = Path('/opt/android')
HOME = Path('/android-home/home')
AVD_HOME = Path('/android-home/avd')
CONFIG = AVD_HOME / 'rdf.avd/config.ini'
TEMPLATE = Path('/usr/local/lib/rdf-hqarroum/config.ini')
SECURE_RAMDISK = Path('/usr/local/lib/rdf-hqarroum/secure-ramdisk.img')
SDCARD = '/android-home/rdf-sdcard.img'
SWITCHES = {'-no-snapshot', '-no-snapshot-load', '-no-snapshot-save', '-no-boot-anim',
            '-wipe-data', '-no-audio', '-noaudio', '-no-window', '-no-cache', '-nocache', '-show-kernel', '-verbose'}
NETWORKS = {'gsm', 'hscsd', 'gprs', 'edge', 'umts', 'hsdpa', 'lte', 'evdo'}


def clean_env(source):
    env = dict(source)
    for name in ['ADBKEY', 'ADBKEY_PUB', 'ANDROID_VENDOR_KEYS', 'ADB_VENDOR_KEYS', 'ADB_SERVER_SOCKET',
                 'ANDROID_ADB_SERVER_ADDRESS', 'ANDROID_ADB_SERVER_PORT', 'SKIP_AUTH', 'EXTRA_FLAGS',
                 'MEMORY', 'CORES', 'GPU_ACCELERATED', 'EMULATOR_PARAMS', 'AVD_CONFIG']:
        env.pop(name, None)
    env.update(HOME=HOME.as_posix(), USER='root', ANDROID_SDK_ROOT=SDK.as_posix(), ANDROID_HOME=SDK.as_posix(),
               ANDROID_AVD_HOME=AVD_HOME.as_posix(), ANDROID_USER_HOME=(HOME / '.android').as_posix(),
               ANDROID_EMULATOR_HOME=(HOME / '.android').as_posix(), ANDROID_SDK_HOME=HOME.as_posix())
    return env


def bounded_int(value, low, high):
    return bool(re.fullmatch(r'[0-9]+', value)) and low <= int(value) <= high


def network_value(value, names, low, high):
    if value in names:
        return True
    return bool(re.fullmatch(r'[0-9]+(?::[0-9]+)?', value)) and all(low <= int(n) <= high for n in value.split(':'))


def parse_params(value):
    if not isinstance(value, str) or len(value) > 4096 or re.search(r'[^A-Za-z0-9_+:/ .-]', value):
        raise ValueError('Invalid EMULATOR_PARAMS')
    words = value.split()
    checked, seen = [], set()
    i = 0
    while i < len(words):
        flag = words[i]
        canonical = {'-noaudio': '-no-audio', '-nocache': '-no-cache'}.get(flag, flag)
        if canonical in seen:
            raise ValueError('Duplicate emulator argument: ' + flag)
        seen.add(canonical)
        checked.append(flag)
        i += 1
        if flag in SWITCHES:
            continue
        if i >= len(words):
            raise ValueError('Missing emulator argument value: ' + flag)
        item = words[i]
        allowed = {
            '-memory': lambda x: bounded_int(x, 1024, 65536),
            '-cores': lambda x: bounded_int(x, 1, 16),
            '-partition-size': lambda x: bounded_int(x, 2048, 131072),
            '-sdcard': lambda x: x == SDCARD,
            '-gpu': lambda x: x == 'swiftshader_indirect',
            '-timezone': lambda x: bool(re.fullmatch(r'[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){1,2}', x)),
            '-change-language': lambda x: bool(re.fullmatch(r'[A-Za-z]{2,3}', x)),
            '-change-country': lambda x: bool(re.fullmatch(r'[A-Za-z]{2}', x)),
            '-netdelay': lambda x: network_value(x, NETWORKS | {'none'}, 0, 60000),
            '-netspeed': lambda x: network_value(x, NETWORKS | {'full'}, 1, 1000000),
            '-camera-back': lambda x: x in {'emulated', 'none', 'environment'},
            '-camera-front': lambda x: x in {'emulated', 'none', 'environment'},
            '-screen': lambda x: x in {'touch', 'multi-touch', 'no-touch'},
        }.get(flag)
        if allowed is None or not allowed(item):
            raise ValueError('Unsupported emulator argument or value: ' + flag)
        checked.append(item)
        i += 1
    return checked


def parse_avd_config(value):
    result = {}
    validators = {
        'disk.dataPartition.size': lambda x: bool(re.fullmatch(r'[0-9]+M', x)) and bounded_int(x[:-1], 2048, 131072),
        'hw.sdCard': lambda x: x in {'yes', 'no'},
        'sdcard.size': lambda x: bool(re.fullmatch(r'[0-9]+M', x)) and bounded_int(x[:-1], 128, 32768),
        'sdcard.path': lambda x: x == SDCARD,
    }
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError('Invalid AVD_CONFIG')
    for line in value.splitlines():
        if not line:
            continue
        key, separator, item = line.partition('=')
        if not separator or key not in validators or key in result or not validators[key](item):
            raise ValueError('Unsupported AVD_CONFIG entry')
        result[key] = item
    return result


def merge_config(template, overrides):
    lines = [line for line in template.splitlines() if line.partition('=')[0].strip() not in overrides]
    return '\n'.join(lines + [key + '=' + value for key, value in overrides.items()]) + '\n'


def install_public_key(value, directory):
    # adb's public format is a 524-byte Android RSAPublicKey, not an SSH key.
    # The public key is also supplied as a boot option: current emulators only
    # derive their default boot key from a private key, which we never import.
    if not isinstance(value, str) or len(value) > 4096 or '\n' in value or '\r' in value or '\0' in value:
        raise ValueError('A farm ADB public key is required')
    parts = value.strip().split()
    if not parts:
        raise ValueError('A farm ADB public key is required')
    try:
        raw = base64.b64decode(parts[0], validate=True)
    except Exception as error:
        raise ValueError('Invalid farm ADB public key') from error
    if len(raw) != 524 or struct.unpack('<I', raw[:4])[0] != 64 or struct.unpack('<I', raw[-4:])[0] not in (3, 65537):
        raise ValueError('Invalid farm ADB RSA public key')
    directory.mkdir(parents=True, exist_ok=True)
    directory.chmod(0o700)
    for name in ['adbkey', 'adbkey.pub']:
        (directory / name).unlink(missing_ok=True)
    key = directory / 'adbkey.pub'
    key.write_text(parts[0] + ' rdf-agent\n', encoding='ascii')
    # With the farm dropping all capabilities, read-only prevents an incidental
    # local adb client from replacing the authorized public key on keygen.
    key.chmod(0o400)
    return parts[0]


def management_ip():
    addresses = subprocess.check_output(['ip', '-4', '-o', 'addr', 'show', 'dev', 'eth0'], text=True)
    match = re.search(r'\binet ([0-9.]+)/', addresses)
    if not match:
        raise ValueError('The isolated management interface eth0 has no IPv4 address')
    return str(ipaddress.IPv4Address(match.group(1)))


def launch_command(params, public_key):
    command = [str(SDK / 'emulator/emulator'), '-avd', 'rdf', '-ports', '5556,5557', '-grpc', '8555', '-no-metrics', '-no-direct-adb',
               '-ramdisk', SECURE_RAMDISK.as_posix(),
               '-append-userspace-opt', 'androidboot.verifiedbootstate=orange',
               '-append-userspace-opt', 'androidboot.qemu.adb.pubkey=' + public_key]
    for flag in ['-no-window', '-no-snapshot', '-no-boot-anim']:
        if flag not in params:
            command.append(flag)
    if '-gpu' not in params:
        command += ['-gpu', 'swiftshader_indirect']
    return command + params


def run_children(commands, env):
    children = []
    stopping = False
    def terminate(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True
        for child in children:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        for command in commands:
            if stopping:
                break
            children.append(subprocess.Popen(command, env=env, start_new_session=True))
        while not stopping:
            for child in children:
                code = child.poll()
                if code is not None:
                    return code if code else 1
            time.sleep(0.1)
        return 0
    finally:
        terminate()
        deadline = time.monotonic() + 5
        for child in children:
            try:
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()


def main():
    params = parse_params(os.environ.get('EMULATOR_PARAMS', ''))
    config = parse_avd_config(os.environ.get('AVD_CONFIG', ''))
    if '-partition-size' in params and config.get('disk.dataPartition.size') not in (None, params[params.index('-partition-size') + 1] + 'M'):
        raise ValueError('Conflicting userdata partition sizes')
    if '-sdcard' in params:
        if config.get('hw.sdCard') == 'no' or not Path(SDCARD).is_file():
            raise ValueError('Farm SD card was not prepared')
    public_key = install_public_key(os.environ.get('ADBKEY_PUB'), HOME / '.android')
    # Console authentication is local to Docker exec; no console port is forwarded.
    console_token = HOME / '.emulator_console_auth_token'
    console_token.write_text(secrets.token_hex(32) + '\n', encoding='ascii')
    console_token.chmod(0o600)
    CONFIG.write_text(merge_config(TEMPLATE.read_text(), config))
    address = management_ip()
    commands = [
        ['socat', 'TCP-LISTEN:5555,bind=' + address + ',reuseaddr,fork', 'TCP:127.0.0.1:5557'],
        ['socat', 'TCP-LISTEN:8554,bind=' + address + ',reuseaddr,fork', 'TCP:127.0.0.1:8555'],
        launch_command(params, public_key),
    ]
    # ADB private keys and upstream SKIP_AUTH/EXTRA_FLAGS never reach the emulator.
    print('Starting farm emulator with authenticated ADB and isolated gRPC', flush=True)
    return run_children(commands, clean_env(os.environ))


if __name__ == '__main__':
    try:
        if sys.argv[1:]:
            raise ValueError('Unsupported adapter command')
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Emulator adapter: ' + str(error), file=sys.stderr)
        sys.exit(1)
