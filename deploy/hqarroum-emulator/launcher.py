#!/usr/bin/env python3
"""Adapt HQarroum's installed SDK to the farm's existing container contract."""
import base64
import gzip
import hashlib
import json
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


def secure_ramdisk(image, platform_policy=None):
    """Use Android init's early property override to require ADB authentication.

    No archive paths are extracted. Preserve all original records verbatim,
    replacing only the two init override files; unknown formats fail the build.
    """
    if platform_policy is not None and (not isinstance(platform_policy, bytes) or
            not 1 <= len(platform_policy) <= 16 * 1024 * 1024 or b'(type ' not in platform_policy):
        raise ValueError('The original platform SELinux CIL is required for Android 12')
    replaced = {b'force_debuggable', b'adb_debug.prop'}
    if platform_policy is not None:
        replaced.add(b'userdebug_plat_sepolicy.cil')
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
    if platform_policy is not None:
        # Android 12 init only preserves the property override after BOTH files
        # copy successfully. Reuse this image's exact platform CIL; never invent
        # an empty/permissive replacement or copy policy from another Android.
        max_inode += 1
        records.append(entry(b'userdebug_plat_sepolicy.cil', platform_policy, max_inode))
    records.append(entry(b'force_debuggable', b'', max_inode + 1))
    records.append(entry(b'adb_debug.prop', b'ro.adb.secure=1\n', max_inode + 2))
    output = []
    for records, trailer, _ in archives:
        archive = b''.join(records) + trailer
        archive += b'\0' * (-len(archive) % 512)
        output.append(archive)
    result = b''.join(output)
    return gzip.compress(result, mtime=0) if compressed or lz4 else result


def read_platform_policy(image_directory, package, base_image, policy_directory=None):
    """Accept only the unchanged policy extracted from the exact pinned API 31 base."""
    policy_directory = Path(policy_directory) if policy_directory is not None else Path(__file__).parent
    manifest = json.loads((policy_directory / 'policy-api31.json').read_text())
    expected_base = manifest.get('upstream', '')
    if (manifest.get('schemaVersion') != 1
            or not re.fullmatch(r'halimqarroum/docker-android@sha256:[0-9a-f]{64}', expected_base)
            or base_image != expected_base):
        raise ValueError('Android 12 policy requires its exact pinned upstream image digest')
    if package != manifest.get('package') or package != 'system-images;android-31;google_apis;x86_64':
        raise ValueError('Android 12 policy does not match the bundled SDK package')
    source_files = manifest.get('sourceFiles', {})
    if set(source_files) != {'source.properties', 'ramdisk.img'}:
        raise ValueError('Android 12 policy manifest has incomplete source identities')
    for name, expected in source_files.items():
        if (not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected)
                or hashlib.sha256((image_directory / name).read_bytes()).hexdigest() != expected):
            raise ValueError('Android 12 policy source identity differs: ' + name)
    policy_info = manifest.get('policy', {})
    if (policy_info.get('file') != 'policy-api31.cil.gz'
            or not isinstance(policy_info.get('bytes'), int)
            or not 1 <= policy_info['bytes'] <= 16 * 1024 * 1024
            or not re.fullmatch(r'[0-9a-f]{64}', str(policy_info.get('sha256', '')))):
        raise ValueError('Android 12 policy manifest is invalid')
    with gzip.open(policy_directory / 'policy-api31.cil.gz', 'rb') as stream:
        policy = stream.read(16 * 1024 * 1024 + 1)
    if (len(policy) != policy_info['bytes'] or b'(type ' not in policy
            or hashlib.sha256(policy).hexdigest() != policy_info['sha256']):
        raise ValueError('Android 12 platform policy checksum or length does not match')
    return policy, {**manifest, 'copiedWithoutChanges': True}


def prepare_image():
    env = clean_env(os.environ)
    HOME.mkdir(parents=True, exist_ok=True)
    (HOME / '.android').mkdir(exist_ok=True)
    AVD_HOME.mkdir(parents=True, exist_ok=True)
    for key in [Path('/root/.android/adbkey'), Path('/root/.android/adbkey.pub')]:
        key.unlink(missing_ok=True)
    manager = SDK / 'cmdline-tools/tools/bin/avdmanager'
    if not manager.is_file():
        manager = SDK / 'cmdline-tools/latest/bin/avdmanager'
    package = os.environ.get('PACKAGE_PATH', '')
    abi = os.environ.get('ABI', '')
    device = os.environ.get('DEVICE_ID', 'pixel')
    if not re.fullmatch(r'system-images;android-[0-9]+(?:\.[0-9]+)?;[a-z0-9_]+;x86(?:_64)?', package):
        raise ValueError('Upstream image must declare an installed x86/x86_64 PACKAGE_PATH')
    api = int(package.split(';')[1][len('android-'):].split('.')[0])
    if api < 31:
        raise ValueError('This adapter requires an Android 12 or newer boot ramdisk')
    if abi != '/'.join(package.split(';')[2:]):
        raise ValueError('Upstream ABI does not match PACKAGE_PATH')
    subprocess.run([str(manager), 'create', 'avd', '--force', '--name', 'rdf', '--package', package,
                    '--abi', abi, '--device', device], input='no\n', text=True, env=env, check=True)
    baseline = merge_config(CONFIG.read_text(), {'hw.ramSize': '2048', 'hw.cpu.ncore': '2',
        'hw.keyboard': 'yes', 'hw.sdCard': 'no'})
    CONFIG.write_text(baseline)
    TEMPLATE.write_text(baseline)
    image_directory = SDK.joinpath(*package.split(';'))
    ramdisk = image_directory / 'ramdisk.img'
    platform_policy = None
    if api == 31:
        platform_policy, report = read_platform_policy(image_directory, package,
                                                        os.environ.get('RDF_EMULATOR_BASE_IMAGE', ''))
        TEMPLATE.with_name('platform-policy.json').write_text(json.dumps(report, indent=2) + '\n')
        print('Copied original platform SELinux CIL: ' + report['policy']['sha256'], flush=True)
    SECURE_RAMDISK.write_bytes(secure_ramdisk(ramdisk.read_bytes(), platform_policy))


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
        if sys.argv[1:] == ['--prepare-image']:
            prepare_image()
        elif sys.argv[1:]:
            raise ValueError('Unsupported adapter command')
        else:
            sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Emulator adapter: ' + str(error), file=sys.stderr)
        sys.exit(1)
