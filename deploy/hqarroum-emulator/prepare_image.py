"""Prepare a fresh AVD and its authenticated boot ramdisk in the builder."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from launcher import AVD_HOME, CONFIG, HOME, SDK, SECURE_RAMDISK, TEMPLATE, clean_env, merge_config
from ramdisk import secure_ramdisk

PREPARED = Path('/rdf-prepared')


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
    PREPARED.mkdir()
    (PREPARED / TEMPLATE.name).write_text(baseline)
    image_directory = SDK.joinpath(*package.split(';'))
    ramdisk = image_directory / 'ramdisk.img'
    platform_policy = None
    if api == 31:
        platform_policy, report = read_platform_policy(image_directory, package,
                                                        os.environ.get('RDF_EMULATOR_BASE_IMAGE', ''))
        (PREPARED / 'platform-policy.json').write_text(json.dumps(report, indent=2) + '\n')
        print('Copied original platform SELinux CIL: ' + report['policy']['sha256'], flush=True)
    (PREPARED / SECURE_RAMDISK.name).write_bytes(secure_ramdisk(ramdisk.read_bytes(), platform_policy))


if __name__ == '__main__':
    try:
        prepare_image()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Emulator adapter: ' + str(error), file=sys.stderr)
        sys.exit(1)
