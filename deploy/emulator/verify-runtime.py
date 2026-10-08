#!/usr/bin/env python3
"""Linux/KVM acceptance test of one digest, form factor and GPU mode.

No daemon/network settings are changed. Only the uniquely named test container
and isolated ADB servers are removed. The result is evidence only when passed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import uuid


def run(args, *, env=None, check=True, timeout=60):
    result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed: {result.stderr[-2000:]}')
    return result


def recv_exact(sock, length):
    data = b''
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise RuntimeError('ADB socket closed before its authentication response')
        data += chunk
    return data


def require_adb_auth(host, port):
    # No key or AUTH reply is sent. An open adbd answers CNXN; a secure adbd asks for AUTH.
    command = int.from_bytes(b'CNXN', 'little')
    payload = b'host::features=cmd,shell_v2;\0'
    packet = struct.pack('<6I', command, 0x01000000, 4096, len(payload), sum(payload), command ^ 0xffffffff) + payload
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(packet)
        header = struct.unpack('<6I', recv_exact(sock, 24))
        if header[0] != int.from_bytes(b'AUTH', 'little') or header[1] != 1 or header[3] != 20:
            raise RuntimeError('ADB accepted a connection without the farm key or returned an invalid AUTH challenge')
        recv_exact(sock, header[3])


class IsolatedAdb:
    def __init__(self, directory):
        self.home = Path(directory)
        android = self.home / '.android'
        android.mkdir(parents=True, mode=0o700)
        # A private socket cannot connect to or kill another application's ADB server.
        self.server_socket = 'localfilesystem:' + str(self.home / 'server.sock')
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(('ADB_', 'ANDROID_'))}
        self.env.update(HOME=str(self.home), ANDROID_USER_HOME=str(android), ANDROID_SDK_HOME=str(self.home),
                        ADB_VENDOR_KEYS=str(android / 'adbkey'), ADB_LOCAL_TRANSPORT_MAX_PORT='0',
                        ADB_MDNS_AUTO_CONNECT='0')
        self.process = None
        self.log = None
        try:
            run(['adb', 'keygen', str(android / 'adbkey')], env=self.env)
            self.public_key = (android / 'adbkey.pub').read_text().strip()
            self.log = (self.home / 'server.log').open('w')
            self.process = subprocess.Popen(
                ['adb', '-L', self.server_socket, '--one-device', 'rdf-verify-' + uuid.uuid4().hex,
                 'server', 'nodaemon'], env=self.env, stdin=subprocess.DEVNULL,
                stdout=self.log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError('Isolated ADB server exited before starting')
                if (self.home / 'server.sock').is_socket():
                    break
                time.sleep(.05)
            else:
                raise RuntimeError('Isolated ADB server did not start')
        except BaseException:
            self.close()
            raise

    def call(self, *args, check=True, timeout=20):
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError('Isolated ADB server is no longer running')
        return run(['adb', '-L', self.server_socket, *args], env=self.env, check=check, timeout=timeout)

    def close(self):
        try:
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            if self.log:
                self.log.close()


DEVICE_PRESETS = {
    'phone': (1080, 2400, 420), 'tablet': (2560, 1600, 320), 'tv': (1920, 1080, 320),
    'automotive': (1408, 792, 160), 'wear': (454, 454, 320),
}



def launch_resource_options(args):
    # Match catalog profiles, with 2 GiB outside Android for the emulator.
    return ['--cpus', str(args.container_cores), '--memory', f'{args.container_memory_mb}m',
            '--memory-swap', f'{args.container_memory_mb}m',
            '-e', f'RDF_RAM_MB={args.ram_mb}', '-e', f'RDF_CORES={args.cores}']


def cpu_ids(value):
    result = set()
    for part in value.strip().split(','):
        if not re.fullmatch(r'[0-9]+(?:-[0-9]+)?', part):
            raise RuntimeError('Android returned an invalid CPU list')
        bounds = [int(item) for item in part.split('-')]
        first, last = bounds[0], bounds[-1]
        if first > last or last > 1023:
            raise RuntimeError('Android returned an invalid CPU range')
        result.update(range(first, last + 1))
    return result


def require_guest_resources(meminfo, present, online, ram_mb, cores):
    present_ids, online_ids = cpu_ids(present), cpu_ids(online)
    if len(present_ids) != cores or not online_ids or not online_ids.issubset(present_ids):
        raise RuntimeError(f'Android CPU allocation does not match {cores} requested cores: present={present.strip()}, online={online.strip()}')
    match = re.search(r'^MemTotal:\s+(\d+)\s+kB\s*$', meminfo, re.M)
    total_kb = int(match.group(1)) if match else 0
    requested_kb = ram_mb * 1024
    # MemTotal excludes kernel/device reservations. Allow 20% for those, but a
    # launcher that silently kept its 2 GiB default must not pass a 4 GiB request.
    if not requested_kb * .8 <= total_kb <= requested_kb:
        raise RuntimeError(f'Android MemTotal {total_kb / 1024:.0f} MiB does not match {ram_mb} requested MiB (expected 80-100% after kernel reservations)')
    return {'memoryTotalKb': total_kb, 'presentCores': len(present_ids), 'onlineCores': len(online_ids)}


def require_device(device, characteristics, features, size, density):
    sizes = re.findall(r'(?:Physical|Override) size:\s*(\d+)x(\d+)', size)
    densities = re.findall(r'(?:Physical|Override) density:\s*(\d+)', density)
    expected = DEVICE_PRESETS[device]
    if not sizes or tuple(map(int, sizes[-1])) != expected[:2] or not densities or int(densities[-1]) != expected[2]:
        raise RuntimeError(f'{device} screen does not match the requested preset {expected[0]}x{expected[1]} @ {expected[2]} dpi')
    # A phone image at a TV resolution must not pass as an Android TV image.
    markers = {part.strip().lower() for part in characteristics.split(',')}
    present = set(re.findall(r'^feature:([^=\r\n]+)', features, re.M))
    dedicated = {
        'tv': 'android.hardware.type.television' in present or 'android.software.leanback' in present or 'tv' in markers,
        'automotive': 'android.hardware.type.automotive' in present or 'automotive' in markers,
        'wear': 'android.hardware.type.watch' in present or 'watch' in markers,
    }
    if device in dedicated and not dedicated[device]:
        raise RuntimeError(f'Android does not identify itself as the requested {device} device')
    if device not in dedicated and any(dedicated.values()):
        raise RuntimeError(f'A dedicated TV, automotive or Wear image cannot verify a {device} profile')


def require_gpu_renderer(mode, renderer):
    software = re.search(r'swiftshader|llvmpipe|softpipe|software renderer', renderer, re.I)
    if mode == 'off':
        if not renderer or not re.search(r'swiftshader', renderer, re.I):
            raise RuntimeError('Software mode has no verified SwiftShader renderer')
    elif not renderer or software:
        raise RuntimeError('GPU requested but SurfaceFlinger has no verified hardware renderer')
    elif mode == 'nvidia' and not re.search(r'\bNVIDIA\b', renderer, re.I):
        raise RuntimeError('NVIDIA requested but SurfaceFlinger does not identify an NVIDIA renderer')
    elif mode == 'dri' and not re.search(r'\b(?:Intel|AMD|Radeon|NVIDIA|Mali|Adreno|Vivante|VideoCore)\b', renderer, re.I):
        raise RuntimeError('DRI requested but SurfaceFlinger does not identify a known hardware renderer')


def cleanup_container(name, identity, report_path):
    errors = []
    try:
        inspected = run(['docker', 'inspect', name], check=False)
        if inspected.returncode:
            if not re.search(r'no such (?:object|container)', inspected.stderr, re.I):
                errors.append('Could not verify the test container during cleanup: ' + inspected.stderr[-1000:])
            return errors
        details = json.loads(inspected.stdout)[0]
        if (details.get('Config', {}).get('Labels') or {}).get('rdf.verification') != identity:
            return ['Container ownership changed; cleanup refused']
        # Use the immutable ID after ownership validation, never a replaceable name.
        container_id = details['Id']
    except Exception as error:
        return ['Container cleanup inspection failed: ' + str(error)]
    try:
        log = run(['docker', 'logs', '--tail', '200', container_id])
        report_path.with_suffix('.log').write_text(log.stdout + log.stderr, encoding='utf-8')
    except Exception as error:
        errors.append('Could not save container logs: ' + str(error))
    try:
        # Removing a large SDK image's writable layer can outlast Docker's stop on a busy disk.
        run(['docker', 'rm', '-f', container_id], timeout=180)
    except Exception as error:
        errors.append('Could not remove test container: ' + str(error))
    return errors


def require_local_docker():
    # /dev/kvm and MemAvailable below describe this machine, not a remote context.
    if os.environ.get('DOCKER_HOST') and not os.environ.get('DOCKER_CONTEXT'):
        endpoint = os.environ['DOCKER_HOST']
    else:
        command = ['docker', 'context', 'inspect']
        if os.environ.get('DOCKER_CONTEXT'):
            command.append(os.environ['DOCKER_CONTEXT'])
        endpoint = run(command + ['--format', '{{.Endpoints.docker.Host}}']).stdout.strip()
    if not endpoint.startswith('unix://'):
        raise RuntimeError('Run runtime verification against the local Unix-socket Docker daemon so KVM and memory checks apply to the tested host')


def require_memory_capacity(meminfo, container_memory_mb=6144):
    match = re.search(r'^MemAvailable:\s+(\d+)\s+kB\s*$', meminfo, re.M)
    available_kb = int(match.group(1)) if match else 0
    required_mb = max(8192, container_memory_mb + 2048)
    if available_kb < required_mb * 1024:
        raise RuntimeError(f'Insufficient available host memory: {available_kb / 1024 / 1024:.1f} GiB; runtime verification needs at least {required_mb / 1024:g} GiB ({container_memory_mb / 1024:g} GiB container + at least 2 GiB reserve)')
    return available_kb


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='farm image pinned with @sha256:...')
    parser.add_argument('--device', choices=list(DEVICE_PRESETS), required=True)
    parser.add_argument('--ram-mb', type=int, help='Android RAM in MiB; default 4096, or 2048 for Wear')
    parser.add_argument('--cores', type=int, help='Android CPU cores; default 4, or 2 for Wear')
    parser.add_argument('--gpu', choices=['off', 'nvidia', 'dri'], default='off')
    parser.add_argument('--dri-device', default='/dev/dri/renderD128')
    parser.add_argument('--nvidia-xorg-dir', help='host modules matching the installed NVIDIA driver')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--nginx-container', help='optional existing farm web container to run nginx -t in')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}', args.image):
        parser.error('--image must be pinned by digest')
    if not 30 <= args.timeout <= 1800:
        parser.error('--timeout must be 30-1800 seconds')
    args.ram_mb = args.ram_mb if args.ram_mb is not None else 2048 if args.device == 'wear' else 4096
    args.cores = args.cores if args.cores is not None else 2 if args.device == 'wear' else 4
    if not 1024 <= args.ram_mb <= 63488:
        parser.error('--ram-mb must be 1024-63488 MiB, leaving 2 GiB within the 64 GiB container limit')
    if not 1 <= args.cores <= 16:
        parser.error('--cores must be 1-16')
    args.container_memory_mb = args.ram_mb + 2048
    args.container_cores = max(4, args.cores)
    return args


def main():
    args = parse_args()
    if os.name != 'posix' or not Path('/dev/kvm').exists():
        raise SystemExit('Run this test on a Linux node with /dev/kvm')
    for binary in ['docker', 'adb']:
        if not shutil.which(binary):
            raise SystemExit(f'{binary} is required')
    identity = uuid.uuid4().hex
    name = 'rdf-verify-' + identity
    report = {'image': args.image, 'device': args.device, 'gpu': args.gpu, 'passed': False,
              'requestedResources': {'guestMemoryMb': args.ram_mb, 'guestCores': args.cores,
                                     'containerMemoryMb': args.container_memory_mb, 'containerCores': args.container_cores}}
    started = time.monotonic()
    container = False
    clients = []
    workspace = None
    args.report.parent.mkdir(parents=True, exist_ok=True)
    try:
        require_local_docker()
        run(['docker', 'pull', args.image], timeout=1800)
        details = json.loads(run(['docker', 'image', 'inspect', args.image]).stdout)[0]
        if (details.get('Config', {}).get('Labels') or {}).get('remote-device-farm.contract') != 'emulator-v1':
            raise RuntimeError('Expected a farm emulator-v1 image')
        report['imageId'] = details['Id']
        report['pullSeconds'] = round(time.monotonic() - started, 2)
        workspace = tempfile.TemporaryDirectory(prefix='rdf-adb-verify-')
        directory = workspace.name
        farm = IsolatedAdb(Path(directory) / 'farm'); clients.append(farm)
        rogue = IsolatedAdb(Path(directory) / 'untrusted'); clients.append(rogue)
        command = ['docker', 'run', '-d', '--name', name, '--label', 'rdf.verification=' + identity,
                   '--device', '/dev/kvm', *launch_resource_options(args), '--shm-size', '256m',
                   '-p', '127.0.0.1::5555', '-e', 'ADBKEY_PUB=' + farm.public_key,
                   '-e', 'RDF_DEVICE=' + args.device, '-e', 'RDF_GPU=' + args.gpu,
                   '-e', 'RDF_EXTRA_ARGS=-adb-path /bin/false']
        if args.gpu == 'nvidia':
            command += ['--runtime', 'nvidia', '--gpus', '1', '-t', '-e', 'NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics,display,video']
            if args.nvidia_xorg_dir:
                modules = Path(args.nvidia_xorg_dir).resolve(strict=True)
                if not modules.is_dir() or not (modules / 'nvidia_drv.so').is_file():
                    raise RuntimeError('NVIDIA Xorg module directory is invalid')
                command += ['--mount', f'type=bind,src={modules},dst=/opt/nvidia-xorg,readonly']
        elif args.gpu == 'dri':
            render = Path(args.dri_device).resolve(strict=True)
            if not re.fullmatch(r'/dev/dri/renderD[0-9]+', str(render)):
                raise RuntimeError('Expected a DRI render node')
            command += ['--device', str(render)]
        report['hostAvailableMemoryKb'] = require_memory_capacity(Path('/proc/meminfo').read_text(), args.container_memory_mb)
        boot_started = time.monotonic()
        container = True
        run(command + [args.image])
        published = run(['docker', 'port', name, '5555/tcp'], check=False)
        endpoint = published.stdout.strip()
        if published.returncode or not re.fullmatch(r'127\.0\.0\.1:[0-9]+', endpoint):
            # An immediate launcher failure removes the published binding. Report
            # the exited emulator, rather than masking it as a Docker port error.
            state = json.loads(run(['docker', 'inspect', name]).stdout)[0]['State']
            if not state['Running']:
                raise RuntimeError('Emulator container exited before Android booted')
            if published.returncode:
                raise RuntimeError('docker port failed: ' + published.stderr[-2000:])
            raise RuntimeError('Expected ADB published only on loopback')
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            state = json.loads(run(['docker', 'inspect', name]).stdout)[0]['State']
            if not state['Running']:
                raise RuntimeError('Emulator container exited before Android booted')
            farm.call('connect', endpoint, check=False)
            boot = farm.call('-s', endpoint, 'shell', 'getprop', 'sys.boot_completed', check=False)
            if boot.returncode == 0 and boot.stdout.strip() == '1':
                break
            time.sleep(2)
        else:
            raise RuntimeError('sys.boot_completed did not become 1 before timeout')
        report['bootSeconds'] = round(time.monotonic() - boot_started, 2)
        # Preserve this evidence even when the raw or untrusted-key check fails.
        report['adbSecure'] = farm.call('-s', endpoint, 'shell', 'getprop', 'ro.adb.secure').stdout.strip()
        require_adb_auth('127.0.0.1', int(endpoint.rsplit(':', 1)[1]))
        rogue.call('connect', endpoint, check=False)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            devices = rogue.call('devices').stdout
            if re.search(re.escape(endpoint) + r'\s+unauthorized(?:\s|$)', devices):
                break
            if re.search(re.escape(endpoint) + r'\s+device(?:\s|$)', devices):
                raise RuntimeError('Untrusted ADB key received device access')
            time.sleep(0.5)
        else:
            raise RuntimeError('Untrusted ADB client did not report unauthorized')
        report['unauthorizedAdb'] = True
        if report['adbSecure'] != '1':
            raise RuntimeError('Android does not report ro.adb.secure=1')
        report['characteristics'] = farm.call('-s', endpoint, 'shell', 'getprop', 'ro.build.characteristics').stdout.strip()
        report['features'] = farm.call('-s', endpoint, 'shell', 'pm', 'list', 'features').stdout
        report['screenSize'] = farm.call('-s', endpoint, 'shell', 'wm', 'size').stdout.strip()
        report['screenDensity'] = farm.call('-s', endpoint, 'shell', 'wm', 'density').stdout.strip()
        require_device(args.device, report['characteristics'], report['features'], report['screenSize'], report['screenDensity'])
        report['guestMeminfo'] = farm.call('-s', endpoint, 'shell', 'cat', '/proc/meminfo').stdout
        report['guestCpuPresent'] = farm.call('-s', endpoint, 'shell', 'cat', '/sys/devices/system/cpu/present').stdout.strip()
        report['guestCpuOnline'] = farm.call('-s', endpoint, 'shell', 'cat', '/sys/devices/system/cpu/online').stdout.strip()
        report['observedResources'] = require_guest_resources(report['guestMeminfo'], report['guestCpuPresent'],
                                                             report['guestCpuOnline'], args.ram_mb, args.cores)
        surface = farm.call('-s', endpoint, 'shell', 'dumpsys', 'SurfaceFlinger').stdout
        report['gles'] = next((line.strip() for line in surface.splitlines() if 'GLES:' in line), '')
        require_gpu_renderer(args.gpu, report['gles'])
        if args.nginx_container:
            run(['docker', 'exec', args.nginx_container, 'nginx', '-t'])
            report['nginxSyntax'] = True
        report['passed'] = True
    except Exception as error:
        report['error'] = str(error)
    finally:
        cleanup_errors = []
        for client in clients:
            try: client.close()
            except Exception as error: cleanup_errors.append('ADB cleanup failed: ' + str(error))
        if container:
            cleanup_errors.extend(cleanup_container(name, identity, args.report))
        if workspace:
            try: workspace.cleanup()
            except Exception as error: cleanup_errors.append('Temporary directory cleanup failed: ' + str(error))
        if cleanup_errors:
            report['passed'] = False
            report['cleanupErrors'] = cleanup_errors
            report.setdefault('error', 'Verification cleanup did not finish successfully')
        args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
