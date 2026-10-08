import importlib.util
import contextlib
import io
from types import SimpleNamespace
from pathlib import Path
import socket
import struct
import threading
import unittest
from unittest.mock import Mock, patch
import json
import subprocess
import tempfile

spec=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('verify-runtime.py'))
runtime=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

class AdbAuthProbeTest(unittest.TestCase):
    def probe(self, command, arg=1, length=20):
        listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1)
        port=listener.getsockname()[1]
        def answer():
            try:
                client,_=listener.accept()
                with client:
                    client.recv(4096)
                    code=int.from_bytes(command,'little')
                    packet=struct.pack('<6I',code,arg,0,length,0,code^0xffffffff)+bytes(length)
                    # Deliberately fragment the header to exercise TCP framing.
                    for offset in range(0,len(packet),3):client.sendall(packet[offset:offset+3])
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError):pass
            finally:listener.close()
        thread=threading.Thread(target=answer);thread.start()
        try:runtime.require_adb_auth('127.0.0.1',port)
        finally:thread.join(timeout=2)
    def test_auth_challenge_required(self):self.probe(b'AUTH')
    def test_open_adbd_refused(self):
        with self.assertRaisesRegex(RuntimeError,'without the farm key'):self.probe(b'CNXN')
    def test_invalid_auth_refused(self):
        with self.assertRaises(RuntimeError):self.probe(b'AUTH',arg=2)
    def test_truncated_response_refused(self):
        reader,writer=socket.socketpair()
        try:
            writer.sendall(b'short');writer.close()
            with self.assertRaisesRegex(RuntimeError,'closed'):runtime.recv_exact(reader,24)
        finally:reader.close()



registry_spec=importlib.util.spec_from_file_location('registry',Path(__file__).with_name('verify-registry.py'))
registry=importlib.util.module_from_spec(registry_spec)
registry_spec.loader.exec_module(registry)

class RuntimeEvidenceTest(unittest.TestCase):
    def test_renderer_must_confirm_requested_mode(self):
        for mode, renderer in [('nvidia','GLES: NVIDIA Corporation, NVIDIA GeForce Example GPU'), ('dri','GLES: Mesa, Intel(R) UHD Graphics'), ('off','GLES: Google, Android Emulator OpenGL ES Translator (Google SwiftShader)')]:
            runtime.require_gpu_renderer(mode, renderer)
        for mode, renderer in [('nvidia','GLES: Mesa, llvmpipe'), ('nvidia','GLES: Google, unknown'), ('nvidia','GLES: Mesa, Intel UHD'), ('dri','GLES: Google, unknown'), ('dri','GLES: Mesa, softpipe'), ('off','GLES: NVIDIA')]:
            with self.subTest(mode=mode, renderer=renderer), self.assertRaises(RuntimeError):
                runtime.require_gpu_renderer(mode, renderer)

    def test_device_geometry_and_android_type_are_required(self):
        runtime.require_device('phone','emulator','feature:android.hardware.telephony','Physical size: 1080x2400','Physical density: 420')
        runtime.require_device('tablet','emulator','','Physical size: 2560x1600','Physical density: 320')
        runtime.require_device('tv','tv','feature:android.software.leanback','Physical size: 1920x1080','Physical density: 320')
        runtime.require_device('wear','watch','feature:android.hardware.type.watch','Physical size: 454x454','Physical density: 320')
        runtime.require_device('automotive','automotive','feature:android.hardware.type.automotive','Physical size: 1408x792','Physical density: 160')
        for device, characteristics, features, size, density in [
            ('tv','emulator','','Physical size: 1920x1080','Physical density: 320'),
            ('tablet','emulator','','Physical size: 1080x2400','Physical density: 420'),
            ('phone','watch','','Physical size: 1080x2400','Physical density: 420'),
            ('phone','emulator','','Physical size: 1080x2400\nOverride size: 720x1280','Physical density: 420'),
        ]:
            with self.subTest(device=device), self.assertRaises(RuntimeError):
                runtime.require_device(device,characteristics,features,size,density)

    def test_available_memory_keeps_two_gib_outside_container(self):
        self.assertEqual(runtime.require_memory_capacity('MemAvailable: 8388608 kB\n'), 8388608)
        for meminfo in ['MemAvailable: 8388607 kB\n', 'MemTotal: 33554432 kB\n', 'MemAvailable: unknown kB']:
            with self.assertRaisesRegex(RuntimeError, 'at least 8 GiB'):
                runtime.require_memory_capacity(meminfo)

    def test_remote_docker_cannot_use_local_host_capacity_check(self):
        with patch.dict(runtime.os.environ, {'DOCKER_HOST':'tcp://remote:2376'}, clear=True):
            with self.assertRaisesRegex(RuntimeError,'local Unix-socket'):
                runtime.require_local_docker()
        with patch.dict(runtime.os.environ, {'DOCKER_CONTEXT':'remote'}, clear=True), patch.object(runtime,'run',return_value=Mock(stdout='ssh://remote')):
            with self.assertRaisesRegex(RuntimeError,'local Unix-socket'):
                runtime.require_local_docker()
        with patch.dict(runtime.os.environ, {'DOCKER_HOST':'unix:///var/run/docker.sock'}, clear=True):
            runtime.require_local_docker()


class GuestResourceVerificationTest(unittest.TestCase):
    def args(self, device='phone', *extra):
        return runtime.parse_args(['--image', 'registry.example/rdf@sha256:' + 'a' * 64,
                                   '--device', device, '--report', 'report.json', *extra])

    def test_cli_device_defaults_reach_container_limits_and_android_environment(self):
        for device in ['phone', 'tablet', 'tv', 'automotive', 'wear']:
            with self.subTest(device=device):
                args = self.args(device)
                options = runtime.launch_resource_options(args)
                guest_mb, cores, container_mb = (2048, 2, 4096) if device == 'wear' else (4096, 4, 6144)
                self.assertIn(f'RDF_RAM_MB={guest_mb}', options)
                self.assertIn(f'RDF_CORES={cores}', options)
                self.assertEqual(options[options.index('--memory') + 1], f'{container_mb}m')
                self.assertEqual(options[options.index('--memory-swap') + 1], f'{container_mb}m')
                self.assertEqual(options[options.index('--cpus') + 1], '4')

    def test_explicit_resources_raise_container_limits_and_host_capacity_requirement(self):
        args = self.args('phone', '--ram-mb', '8192', '--cores', '8')
        options = runtime.launch_resource_options(args)
        self.assertIn('RDF_RAM_MB=8192', options)
        self.assertIn('RDF_CORES=8', options)
        self.assertEqual(options[options.index('--memory') + 1], '10240m')
        self.assertEqual(options[options.index('--cpus') + 1], '8')
        with self.assertRaisesRegex(RuntimeError, 'at least 12 GiB'):
            runtime.require_memory_capacity('MemAvailable: 8388608 kB', args.container_memory_mb)
        runtime.require_memory_capacity('MemAvailable: 12582912 kB', args.container_memory_mb)

    def test_invalid_cli_resources_are_rejected_before_launch(self):
        for flag, value in [('--ram-mb', '0'), ('--ram-mb', '65536'), ('--cores', '0'), ('--cores', '17')]:
            with self.subTest(flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.args('phone', flag, value)

    def test_android_kernel_reservations_and_cpu_hotplug_are_allowed(self):
        observed = runtime.require_guest_resources('MemTotal: 3900000 kB\nMemFree: 100000 kB', '0-3', '0-1', 4096, 4)
        self.assertEqual(observed, {'memoryTotalKb': 3900000, 'presentCores': 4, 'onlineCores': 2})
        runtime.require_guest_resources('MemTotal: 1850000 kB', '0-1', '0-1', 2048, 2)

    def test_ignored_ram_or_core_settings_and_invalid_readings_fail(self):
        for meminfo, present, online in [
            ('MemTotal: 1950000 kB', '0-3', '0-3'),
            ('MemTotal: 6200000 kB', '0-3', '0-3'),
            ('MemTotal: 3900000 kB', '0-1', '0-1'),
            ('MemTotal: 3900000 kB', '0-3', '0-4'),
            ('MemFree: 3900000 kB', '0-3', '0-3'),
            ('MemTotal: 3900000 kB', 'not-a-list', '0-3'),
        ]:
            with self.subTest(meminfo=meminfo, present=present, online=online), self.assertRaises(RuntimeError):
                runtime.require_guest_resources(meminfo, present, online, 4096, 4)

    def test_main_launch_passes_cli_resources_and_cannot_pass_ignored_guest_ram(self):
        # Exercise the actual launch/ADB/report path, with no Docker or shared ADB.
        for guest_kb, expected_status in [(2900000, 0), (1950000, 1)]:
            with self.subTest(guest_kb=guest_kb), tempfile.TemporaryDirectory() as directory:
                report_path = Path(directory) / 'report.json'
                def command(argv, **kwargs):
                    if argv[:3] == ['docker', 'image', 'inspect']:
                        return SimpleNamespace(stdout=json.dumps([{'Id': 'image', 'Config': {'Labels': {'remote-device-farm.contract': 'emulator-v1'}}}]), returncode=0)
                    if argv[:2] == ['docker', 'inspect']:
                        return SimpleNamespace(stdout=json.dumps([{'State': {'Running': True}}]), returncode=0)
                    if argv[:2] == ['docker', 'port']:
                        return SimpleNamespace(stdout='127.0.0.1:55555', returncode=0)
                    return SimpleNamespace(stdout='', stderr='', returncode=0)
                def adb_call(*argv, **kwargs):
                    result = {
                        'sys.boot_completed': '1', 'ro.adb.secure': '1', 'ro.build.characteristics': 'emulator',
                        'features': 'feature:android.hardware.telephony', 'size': 'Physical size: 1080x2400',
                        'density': 'Physical density: 420', 'SurfaceFlinger': 'GLES: Google SwiftShader',
                        '/proc/meminfo': f'MemTotal: {guest_kb} kB', '/sys/devices/system/cpu/present': '0-2',
                        '/sys/devices/system/cpu/online': '0-2', 'devices': '127.0.0.1:55555 unauthorized',
                    }.get(argv[-1], '')
                    return SimpleNamespace(stdout=result, returncode=0)
                clients = [Mock(public_key='test-public-key'), Mock(public_key='untrusted-key')]
                for client in clients: client.call.side_effect = adb_call
                argv = ['verify-runtime.py', '--image', 'registry.example/rdf@sha256:' + 'a' * 64,
                        '--device', 'phone', '--ram-mb', '3072', '--cores', '3', '--report', str(report_path)]
                with patch('sys.argv', argv), patch.object(runtime, 'os', SimpleNamespace(name='posix')), \
                     patch.object(Path, 'exists', return_value=True), patch.object(runtime.shutil, 'which', return_value='/binary'), \
                     patch.object(runtime, 'require_local_docker'), patch.object(runtime, 'require_adb_auth'), \
                     patch.object(runtime, 'IsolatedAdb', side_effect=clients), patch.object(runtime, 'run', side_effect=command) as launched, \
                     patch.object(Path, 'read_text', return_value='MemAvailable: 16777216 kB'), \
                     patch.object(runtime, 'cleanup_container', return_value=[]) as cleanup, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(runtime.main(), expected_status)
                docker_run = next(call.args[0] for call in launched.call_args_list if call.args[0][:2] == ['docker', 'run'])
                self.assertIn('RDF_RAM_MB=3072', docker_run)
                self.assertIn('RDF_CORES=3', docker_run)
                self.assertEqual(docker_run[docker_run.index('--memory') + 1], '5120m')
                report = json.loads(report_path.read_text(encoding='utf-8'))
                self.assertEqual(report['passed'], expected_status == 0)
                self.assertEqual(report['requestedResources']['guestMemoryMb'], 3072)
                if expected_status:
                    self.assertIn('MemTotal', report['error'])
                else:
                    self.assertEqual(report['observedResources']['presentCores'], 3)
                cleanup.assert_called_once()
                for client in clients: client.close.assert_called_once()


class RuntimeFailureDiagnosticsTest(unittest.TestCase):
    def run_failure(self, *, secure='0', raw_error=None, running=True, port_error=False):
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory) / 'report.json'
            events = []
            def command(argv, **kwargs):
                if argv[:3] == ['docker', 'image', 'inspect']:
                    return SimpleNamespace(stdout=json.dumps([{'Id': 'image', 'Config': {'Labels': {'remote-device-farm.contract': 'emulator-v1'}}}]), returncode=0)
                if argv[:2] == ['docker', 'port']:
                    self.assertFalse(kwargs['check'])
                    return SimpleNamespace(stdout='' if port_error else '127.0.0.1:55555',
                                           returncode=1 if port_error else 0, stderr='no public port')
                if argv[:2] == ['docker', 'inspect']:
                    return SimpleNamespace(stdout=json.dumps([{'State': {'Running': running}}]), returncode=0)
                return SimpleNamespace(stdout='', stderr='', returncode=0)
            def adb_call(*argv, **kwargs):
                events.append(argv[-1])
                return SimpleNamespace(stdout={'sys.boot_completed': '1', 'ro.adb.secure': secure,
                                                'devices': '127.0.0.1:55555 unauthorized'}.get(argv[-1], ''), returncode=0)
            def raw_check(*_args):
                events.append('raw-auth-check')
                if raw_error:
                    raise RuntimeError(raw_error)
            clients = [Mock(public_key='farm-public-key'), Mock(public_key='untrusted-public-key')]
            for client in clients:
                client.call.side_effect = adb_call
            argv = ['verify-runtime.py', '--image', 'registry.example/rdf@sha256:' + 'a' * 64,
                    '--device', 'phone', '--report', str(report_path)]
            with patch('sys.argv', argv), patch.object(runtime, 'os', SimpleNamespace(name='posix')), \
                 patch.object(Path, 'exists', return_value=True), patch.object(runtime.shutil, 'which', return_value='/binary'), \
                 patch.object(runtime, 'require_local_docker'), patch.object(runtime, 'require_adb_auth', side_effect=raw_check), \
                 patch.object(runtime, 'IsolatedAdb', side_effect=clients), patch.object(runtime, 'run', side_effect=command), \
                 patch.object(Path, 'read_text', return_value='MemAvailable: 16777216 kB'), \
                 patch.object(runtime, 'cleanup_container', return_value=[]) as cleanup, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runtime.main(), 1)
            report = json.loads(report_path.read_text(encoding='utf-8'))
            self.assertFalse(report['passed'])
            cleanup.assert_called_once()
            for client in clients:
                client.close.assert_called_once()
            return report, events

    def test_report_preserves_adb_property_when_actual_authentication_fails(self):
        for secure in ('0', '1'):
            with self.subTest(secure=secure):
                report, events = self.run_failure(secure=secure, raw_error='ADB accepted a connection without the farm key')
                self.assertEqual(report['adbSecure'], secure)
                self.assertIn('without the farm key', report['error'])
                self.assertIn('bootSeconds', report)
                self.assertLess(events.index('ro.adb.secure'), events.index('raw-auth-check'))
                self.assertNotIn('unauthorizedAdb', report)

    def test_insecure_property_does_not_skip_protocol_or_rogue_key_checks(self):
        report, events = self.run_failure(secure='0')
        self.assertEqual(report['adbSecure'], '0')
        self.assertIn('ro.adb.secure=1', report['error'])
        self.assertTrue(report['unauthorizedAdb'])
        self.assertLess(events.index('ro.adb.secure'), events.index('raw-auth-check'))
        self.assertLess(events.index('raw-auth-check'), events.index('devices'))

    def test_missing_port_reports_early_container_exit(self):
        report, events = self.run_failure(running=False, port_error=True)
        self.assertEqual(report['error'], 'Emulator container exited before Android booted')
        self.assertNotIn('bootSeconds', report)
        self.assertEqual(events, [])

    def test_live_container_port_error_is_not_mislabeled_as_exit(self):
        report, events = self.run_failure(running=True, port_error=True)
        self.assertIn('docker port failed: no public port', report['error'])
        self.assertEqual(events, [])


class VerificationCleanupTest(unittest.TestCase):
    def test_log_failure_does_not_skip_owned_container_removal(self):
        owned={'Id':'immutable-id','Config':{'Labels':{'rdf.verification':'mine'}}}
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime,'run',side_effect=[
            Mock(returncode=0, stdout=json.dumps([owned])), RuntimeError('logs timeout'), Mock(returncode=0),
        ]) as command:
            errors=runtime.cleanup_container('mutable-name','mine',Path(directory)/'report.json')
        self.assertIn('logs timeout',errors[0])
        self.assertEqual(command.call_args_list[-1].args[0],['docker','rm','-f','immutable-id'])
        self.assertEqual(command.call_args_list[-1].kwargs['timeout'],180)

    def test_unowned_container_is_not_logged_or_removed(self):
        foreign={'Id':'foreign','Config':{'Labels':{'rdf.verification':'someone-else'}}}
        with patch.object(runtime,'run',return_value=Mock(returncode=0,stdout=json.dumps([foreign]))) as command:
            errors=runtime.cleanup_container('name','mine',Path('unused.json'))
        self.assertEqual(command.call_count,1)
        self.assertIn('ownership changed',errors[0])

    def test_removal_failure_is_reported(self):
        owned={'Id':'mine','Config':{'Labels':{'rdf.verification':'mine'}}}
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime,'run',side_effect=[
            Mock(returncode=0,stdout=json.dumps([owned])), Mock(stdout='log',stderr=''), RuntimeError('remove timeout'),
        ]):
            errors=runtime.cleanup_container('name','mine',Path(directory)/'report.json')
        self.assertIn('remove timeout',errors[0])

    def test_adb_server_is_owned_and_never_uses_shared_discovery(self):
        process=Mock();process.poll.return_value=None
        def keygen(args, **kwargs):
            if args[1]=='keygen':Path(args[2]+'.pub').write_text('public-key')
            return Mock(returncode=0)
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime,'run',side_effect=keygen) as command, patch.object(runtime.subprocess,'Popen',return_value=process) as spawn, patch.object(Path,'is_socket',return_value=True):
            adb=runtime.IsolatedAdb(Path(directory)/'isolated')
            argv=spawn.call_args.args[0]
            self.assertEqual(argv[-2:],['server','nodaemon'])
            self.assertTrue(argv[2].startswith('localfilesystem:'))
            self.assertIn('--one-device',argv)
            self.assertEqual(adb.env['ADB_LOCAL_TRANSPORT_MAX_PORT'],'0')
            self.assertEqual(adb.env['ADB_MDNS_AUTO_CONNECT'],'0')
            adb.call('devices')
            self.assertEqual(command.call_args.args[0],['adb','-L',adb.server_socket,'devices'])
            adb.close()
            process.terminate.assert_called_once()
            self.assertFalse(any('kill-server' in call.args[0] for call in command.call_args_list))

    def test_adb_failed_start_is_reaped(self):
        process=Mock();process.poll.return_value=1
        def keygen(args, **kwargs):Path(args[2]+'.pub').write_text('public-key')
        with tempfile.TemporaryDirectory() as directory, patch.object(runtime,'run',side_effect=keygen), patch.object(runtime.subprocess,'Popen',return_value=process):
            with self.assertRaisesRegex(RuntimeError,'exited before starting'):
                runtime.IsolatedAdb(Path(directory)/'isolated')

class RegistryEvidenceTest(unittest.TestCase):
    def test_shared_or_warm_cache_is_rejected(self):
        image_id = 'sha256:' + 'b' * 64
        with patch.object(registry, 'docker', return_value='[]') as command:
            with self.assertRaisesRegex(RuntimeError, 'already has the built image'):
                registry.require_uncached_consumer('consumer', image_id)
        command.assert_called_once_with('consumer', ['image', 'inspect', image_id])

    def test_only_missing_exact_image_allows_download(self):
        image_id = 'sha256:' + 'b' * 64
        for prefix in ['Error response from daemon: ', 'Error: ']:
            with self.subTest(prefix=prefix), patch.object(registry, 'docker', side_effect=registry.DockerError(
                'consumer', ['image'], prefix + 'No such image: ' + image_id + '\n')):
                registry.require_uncached_consumer('consumer', image_id)

    def test_consumer_failures_are_not_reported_as_empty_cache(self):
        image_id = 'sha256:' + 'b' * 64
        for message in ['permission denied', 'Cannot connect to the Docker daemon',
                        'Error: No such image: sha256:' + 'c' * 64]:
            error = registry.DockerError('consumer', ['image'], message)
            with self.subTest(message=message), patch.object(registry, 'docker', side_effect=error):
                with self.assertRaises(registry.DockerError) as caught:
                    registry.require_uncached_consumer('consumer', image_id)
                self.assertIs(caught.exception, error)

    def test_loopback_is_rejected_with_or_without_port(self):
        for address in ['localhost/rdf-emulator','localhost:5000/rdf-emulator','127.0.0.1/rdf-emulator','127.2.3.4:5000/rdf-emulator','0.0.0.0/rdf-emulator','farm.localhost/rdf-emulator','registry.example:65536/rdf-emulator']:
            with self.subTest(address=address),self.assertRaises(ValueError):registry.validate_repository(address)
        registry.validate_repository('registry.example:5000/mobile/rdf-emulator')

    def test_registry_digest_must_match_full_repository_and_contract(self):
        package='system-images;android-34;google_apis;x86_64'
        repository='registry.example/rdf-emulator';digest='sha256:'+'a'*64
        source={'Id':'sha256:'+'b'*64,'Config':{'Labels':{'remote-device-farm.contract':'emulator-v1','remote-device-farm.system-image':package}}}
        target={'Id':source['Id'],'RepoDigests':[repository+'@'+digest]}
        registry.verify_pulled_image(source,target,repository,digest,package)
        for invalid in [dict(target,RepoDigests=['another.example/rdf-emulator@'+digest]),dict(target,Id='sha256:'+'c'*64)]:
            with self.assertRaises(RuntimeError):registry.verify_pulled_image(source,invalid,repository,digest,package)
        with self.assertRaises(RuntimeError):registry.verify_pulled_image(source,target,repository,digest,'system-images;android-30;default;x86_64')

if __name__=='__main__':unittest.main()
